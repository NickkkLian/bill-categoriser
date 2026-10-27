"""Offline file intake and the existing cleaning policy, exercised through the CLI."""
import csv
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import demo
import xlsx_io as xlsx


class TestClean(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def csv(self, name, rows, delimiter=','):
        path = self.base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('w', encoding='utf-8-sig', newline='') as f:
            csv.writer(f, delimiter=delimiter).writerows(rows)
        return path

    def run_cli(self, *args, ok=True):
        r = subprocess.run([sys.executable, '-B', str(ROOT / 'demo.py'), *map(str, args)],
                           cwd=self.base, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0 if ok else 1, r.stdout + r.stderr)
        return r

    def clean(self, *paths, extra=()):
        out = self.base / 'result'
        self.run_cli('clean', *paths, '--out', out, *extra)
        return out, json.loads((out / 'ledger.json').read_text())

    def test_csv_multiple_files_policy_provenance_and_check(self):
        a = self.csv('a/export.csv', [['monthly export'], [],
            ['Note', 'Total CAD', 'Invoice date', 'Merchant name', 'Bill ID'],
            ['ignored', '12.30', '2026-01-02', '  DEMO-SUPPLY-01 ', ' X '],
            ['', '12,34.00', '2026-01-03', 'Unknown', 'bad'],
            ['', '', '2026-01-03', 'Unknown', 'missing'],
            ['', '4.00', '03/04/2026', 'Unknown', 'ambiguous']], ';')
        b = self.csv('b/export.csv', [['Reference', 'Payee', 'Billed on', 'Gross amount'],
            ['X', 'Demo Supply 01', '2026-01-02', 'CAD 12.30'],
            ['Y', 'Demo Supply 01', '2026-01-02', '12.30'],
            ['refund', '=LITERAL()', '2026/02/01', '(CAD 5.00)']])
        out, m = self.clean(a, b, extra=('--high-cad', '10'))
        r = m['records']
        self.assertEqual([x['status'] for x in r],
                         ['clean', 'unparseable', 'unparseable', 'unparseable', 'duplicate', 'clean', 'clean'])
        self.assertEqual(r[0]['category'], 'Supplies')
        self.assertIsNone(r[1]['cents'], 'malformed amounts must never be repaired')
        self.assertIsNone(r[2]['cents'])
        self.assertEqual(r[4]['duplicate_of'], r[0]['id'])
        self.assertTrue(any('possible duplicate' in s for s in r[5]['reasons']))
        self.assertTrue(any('high amount' in s for s in r[5]['reasons']))
        self.assertEqual(len({x['id'] for x in r}), len(r))
        self.assertNotEqual(r[0]['source_file'], r[4]['source_file'])
        self.assertEqual((r[0]['source_row'], r[0]['raw'][0]), (4, ' X '))
        self.assertEqual(m['reconciliation']['known_input_cents'], 3590)
        self.run_cli('check', '--out', out, '--high-cad', '10')
        first = (out / 'cleaned-bills.xlsx').read_bytes()
        self.clean(a, b, extra=('--high-cad', '10'))
        self.assertEqual(first, (out / 'cleaned-bills.xlsx').read_bytes())
        m['records'].pop()
        (out / 'ledger.json').write_text(json.dumps(m))
        self.run_cli('check', '--out', out, '--high-cad', '10', ok=False)

    def test_xlsx_arbitrary_sheets_and_numeric_amounts(self):
        path = self.base / 'custom.xlsx'
        xlsx.fill(ROOT / 'templates/input-template.xlsx', path, {
            'Export A': [['i1', 'Demo Software 03', '2024-12-31', 1.5]],
            'Export B': [['i2', 'Unknown', '2026-01-01', 0]],
            'Export C': []})
        parts = xlsx.files(path)
        root = ET.fromstring(parts['xl/workbook.xml'])
        for i, s in enumerate(root.find(xlsx.tag('sheets'))):
            s.set('name', 'Custom ' + str(i))
        parts['xl/workbook.xml'] = ET.tostring(root)
        xlsx.save_parts(path, parts)
        out, m = self.clean(path)
        self.assertEqual([r['cents'] for r in m['records']], [150, 0])
        self.assertEqual([r['status'] for r in m['records']], ['clean', 'clean'])
        self.assertEqual(m['records'][0]['source_sheet'], 'Custom 0')
        summary = xlsx.read(out / 'cleaned-bills.xlsx')['Summary']
        months = {r[0]: r[1]['value'] for r in summary.values()
                  if r and isinstance(r[0], str) and r[0] in ('2024-12', '2026-01')}
        self.assertEqual(months, {'2024-12': 1.5, '2026-01': 0})
        self.run_cli('check', '--out', out)

    def test_reject_unsupported_unmapped_ambiguous_and_formula_inputs(self):
        cases = [('bad.csv', [['Vendor', 'Amount'], ['Acme', '1.00']]),
                 ('ambiguous.csv', [['Invoice', 'Vendor', 'Merchant', 'Date', 'Amount']]),
                 ('extra.csv', [['Invoice', 'Vendor', 'Date', 'Amount'], ['i', 'v', '2026-01-01', '1.00', 'lost']])]
        for name, rows in cases:
            with self.subTest(name=name):
                self.run_cli('clean', self.csv(name, rows), '--out', self.base / name.replace('.csv', ''), ok=False)
        unsupported = self.base / 'bill.pdf'
        unsupported.write_text('not a bill export')
        self.run_cli('clean', unsupported, '--out', self.base / 'pdf', ok=False)
        path = self.base / 'formula.xlsx'
        xlsx.fill(ROOT / 'templates/input-template.xlsx', path, {
            'Export A': [['x', 'v', '2026-01-01', {'formula': '1+1', 'value': 2}]],
            'Export B': [], 'Export C': []})
        self.run_cli('clean', path, '--out', self.base / 'formula', ok=False)

    def test_no_retained_bills_has_valid_ranges_and_unknown_amounts(self):
        path = self.csv('unknown.csv', [['Invoice', 'Vendor', 'Date', 'Amount'], ['i', 'v', '', '']])
        out, m = self.clean(path)
        self.assertEqual(m['reconciliation']['unknown_amount_rows'], 1)
        self.assertEqual(m['reconciliation']['counts']['clean'], 0)
        for rows in xlsx.read(out / 'cleaned-bills.xlsx').values():
            for row in rows.values():
                for v in row:
                    if isinstance(v, dict):
                        self.assertNotRegex(v['formula'], r'[A-Z]5:[A-Z]4')
        self.run_cli('check', '--out', out)

    def test_browser_rules_reuse_and_verification_keep_the_recorded_policy(self):
        rules = {'aliases': [{'alias': 'Cedar Stationery', 'category': 'Supplies'},
                             {'alias': 'Demo Supply 01', 'category': 'Rent'}], 'high_cad': 10.50}
        policy = self.base / 'rules.json'
        policy.write_text(json.dumps(rules))
        january = self.csv('january.csv', [['Invoice', 'Vendor', 'Date', 'Amount'],
            ['a', ' CEDAR-STATIONERY ', '2026-01-03', '12.30'],
            ['b', 'DEMO SUPPLY 01', '2026-01-04', '2.00']])
        out = self.base / 'january'
        result = self.run_cli('clean', january, '--rules', policy, '--verify', '--out', out)
        self.assertIn('CHECK PASS', result.stdout)
        self.assertIn('two rebuilds and delivered files match', result.stdout)
        model = json.loads((out / 'ledger.json').read_text())
        self.assertEqual(model['high_amount_cents'], 1050)
        self.assertEqual(model['rules'], rules)
        self.assertEqual([r['category'] for r in model['records']], ['Supplies', 'Rent'])
        self.assertEqual(model['records'][0]['merchant'], 'Cedar Stationery')
        self.assertTrue(any('high amount' in s for s in model['records'][0]['reasons']))
        self.assertTrue(any(c['rule'] == 'reviewer alias rule' for c in model['changes']))
        self.run_cli('check', '--out', out, '--rules', policy)
        self.run_cli('check', '--out', out, '--high-cad', '11', ok=False)
        rules['aliases'][0]['category'] = 'Software'
        policy.write_text(json.dumps(rules))
        mismatch = self.run_cli('check', '--out', out, '--rules', policy, ok=False)
        self.assertIn('supplied rules differ', mismatch.stdout)
        policy.unlink()
        self.run_cli('check', '--out', out)  # The frozen policy travels with the ledger.
        rules['aliases'][0]['category'] = 'Supplies'
        policy.write_text(json.dumps(rules))
        february = self.csv('february.csv', [['Invoice', 'Vendor', 'Date', 'Amount'],
            ['c', 'cedar stationery', '2026-02-02', '3.00']])
        next_out = self.base / 'february'
        self.run_cli('clean', february, '--rules', policy, '--verify', '--out', next_out)
        self.assertEqual(json.loads((next_out / 'ledger.json').read_text())['records'][0]['category'], 'Supplies')

    def test_rules_reject_bad_policy_before_writing_output(self):
        path = self.csv('one.csv', [['Invoice', 'Vendor', 'Date', 'Amount'],
                                  ['i', 'Cedar Stationery', '2026-01-01', '1.00']])
        policy = self.base / 'rules.json'
        invalid = [[], {'aliases': [], 'high_cad': -1},
            {'aliases': [], 'high_cad': 1.001}, {'aliases': [], 'high_cad': True},
            {'aliases': [{'alias': 'Cedar', 'category': 'Invented'}], 'high_cad': 10},
            {'aliases': [{'alias': '!!!', 'category': 'Supplies'}], 'high_cad': 10},
            {'aliases': [{'alias': 'Cedar', 'category': 'Supplies'},
                         {'alias': 'CEDAR!', 'category': 'Rent'}], 'high_cad': 10}]
        out = self.base / 'bad-policy'
        for value in invalid:
            with self.subTest(value=value):
                policy.write_text(json.dumps(value))
                self.run_cli('clean', path, '--rules', policy, '--out', out, ok=False)
                self.assertFalse(out.exists(), 'invalid policy must not produce a workbook')
        policy.write_text(json.dumps({'aliases': [], 'high_cad': 10}))
        result = self.run_cli('clean', path, '--rules', policy, '--high-cad', '20', '--out', out, ok=False)
        self.assertIn('conflicts', result.stdout)
        self.assertFalse(out.exists())
        # A rule document is also an input and must not be overwritten by the ledger.
        target = self.base / 'ledger.json'
        target.write_bytes(policy.read_bytes())
        before = target.read_bytes()
        self.run_cli('clean', path, '--rules', target, '--out', self.base, ok=False)
        self.assertEqual(target.read_bytes(), before)

    def test_clean_verify_rejects_a_damaged_written_workbook(self):
        path = self.csv('one.csv', [['Invoice', 'Vendor', 'Date', 'Amount'],
                                  ['i', 'Demo Supply 01', '2026-01-01', '1.00']])
        out = self.base / 'damaged'
        original_clean = demo.clean_files
        def corrupt(*args):
            model = original_clean(*args)
            workbook = Path(args[1]) / 'cleaned-bills.xlsx'
            parts = xlsx.files(workbook)
            sheet_path = xlsx.sheet_paths(parts)['Bills']
            sheet = ET.fromstring(parts[sheet_path])
            rows = sheet.find(xlsx.tag('sheetData'))
            rows.remove(next(r for r in rows if r.get('r') == '5'))
            parts[sheet_path] = ET.tostring(sheet)
            xlsx.save_parts(workbook, parts)
            return model
        output = io.StringIO()
        with patch.object(demo, 'clean_files', corrupt), patch.object(sys, 'argv',
                ['demo.py', 'clean', str(path), '--verify', '--out', str(out)]), contextlib.redirect_stdout(output):
            status = demo.main()
        self.assertEqual(status, 1)
        self.assertIn('FAIL: Bills: row count', output.getvalue())
        self.assertNotIn('CHECK PASS', output.getvalue())

    def test_clean_default_output_does_not_replace_delivered_sample(self):
        path = self.csv('one.csv', [['Invoice', 'Vendor', 'Date', 'Amount'], ['i', 'v', '2026-01-01', '0.00']])
        self.run_cli('clean', path)
        self.assertTrue((self.base / 'output-clean' / 'ledger.json').exists())

    def test_checker_rejects_workbook_mutation_and_source_change(self):
        path = self.csv('one.csv', [['Invoice', 'Vendor', 'Date', 'Amount'], ['i', 'v', '2026-01-01', '1.00']])
        out, _ = self.clean(path)
        saved = (out / 'cleaned-bills.xlsx').read_bytes()
        parts = xlsx.files(out / 'cleaned-bills.xlsx')
        p = xlsx.sheet_paths(parts)['Bills']
        root = ET.fromstring(parts[p]); data = root.find(xlsx.tag('sheetData'))
        data.remove(next(r for r in data if r.get('r') == '5'))
        parts[p] = ET.tostring(root)
        xlsx.save_parts(out / 'cleaned-bills.xlsx', parts)
        self.run_cli('check', '--out', out, ok=False)
        (out / 'cleaned-bills.xlsx').write_bytes(saved)
        path.write_text(path.read_text().replace('1.00', '2.00'))
        self.run_cli('check', '--out', out, ok=False)

    def test_quoted_semicolon_csv_and_multiline_merchant(self):
        path = self.base / 'quoted.csv'
        with path.open('w', newline='', encoding='utf-8') as f:
            csv.writer(f, delimiter=';', quoting=csv.QUOTE_ALL).writerows([
                ['Invoice', 'Vendor', 'Date', 'Amount'],
                ['i', 'Private\nMerchant', '2026-01-01', '1.00']])
        _, m = self.clean(path)
        self.assertEqual(m['records'][0]['raw'][1], 'Private\nMerchant')

    def test_numeric_excel_precision_is_not_rounded(self):
        path = self.base / 'precision.xlsx'
        xlsx.fill(ROOT / 'templates/input-template.xlsx', path, {
            'Export A': [['x', 'v', '2026-01-01', 1.999]], 'Export B': [], 'Export C': []})
        _, m = self.clean(path)
        self.assertIsNone(m['records'][0]['cents'])
        self.assertEqual(m['records'][0]['raw'][3], '1.999')

    def test_output_cannot_overwrite_input_or_demo(self):
        path = self.base / 'cleaned-bills.xlsx'
        xlsx.fill(ROOT / 'templates/input-template.xlsx', path, {
            'Export A': [['x', 'v', '2026-01-01', 1]], 'Export B': [], 'Export C': []})
        original = path.read_bytes()
        self.run_cli('clean', path, '--out', self.base, ok=False)
        self.assertEqual(path.read_bytes(), original)
        (self.base / 'dirty-input.xlsx').write_bytes(original)
        self.run_cli('clean', path, '--out', self.base, ok=False)
        self.run_cli('clean', path, path, '--out', self.base / 'repeated', ok=False)


if __name__ == '__main__':
    unittest.main()
