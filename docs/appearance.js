/* The approved product palette has one header theme control. */
(() => {
  const shortcutsOn = () => { try { return localStorage.getItem('bill-bench-shortcuts') !== 'off'; } catch { return true; } };
  window.Appearance = {
    shortcutsOn,
    bindToggle() {},
    bindSettings(button) {
      if (!button) return;
      button.addEventListener('click', () => {
        let dialog = document.querySelector('#shortcut-settings');
        if (!dialog) {
          dialog = document.createElement('dialog');
          dialog.id = 'shortcut-settings';
          dialog.innerHTML = '<form method="dialog"><div class="dialog-title"><h2>Keyboard settings</h2><button aria-label="Close settings">Close</button></div><label><input type="checkbox" id="shortcut-switch"> Enable single-key shortcuts</label><p>Letter keys act inside the review queue. The question mark opens help. Saved in this browser.</p></form>';
          document.body.append(dialog);
          dialog.querySelector('input').addEventListener('change', event => { try { localStorage.setItem('bill-bench-shortcuts', event.target.checked ? 'on' : 'off'); } catch {} });
        }
        dialog.querySelector('input').checked = shortcutsOn();
        dialog.showModal();
      });
    }
  };
})();
