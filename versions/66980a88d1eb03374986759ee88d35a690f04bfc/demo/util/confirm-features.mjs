function redP(textContent) {
  const p = document.createElement('p');
  p.style.color = 'red';
  p.textContent = textContent;
  return p;
}

/**
 * Checks that the features needed are present in the browser. If not,
 * it places error messages inside |element|.
 **/
class ConfirmFeatures extends HTMLElement {
  constructor() {
    super();
    if (this.displayLock === undefined) {
      this.appendChild(redP('Display Locking is not available'));
    }

    const slot = document.createElement('slot');
    if (!slot.assign) {
      const div = redP('Manual Slot Assignment is not available');
      this.appendChild(div);
    }
  }
}

customElements.define('confirm-features', ConfirmFeatures);
