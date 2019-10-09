import * as Params from './Params.mjs';
export class Locker {
  constructor(size) {
    this.size = size || [10, 50];
  }

  lock(element, andThen) {
    let size = element.lockSize ? [10, element.lockSize] : this.size;
    element.setAttribute('rendersubtree', 'invisible activatable');
    element.style.contentSize = `${size[0]}px ${size[1]}px`;
  }

  update(element, andThen) {
    return element.updateRendering();
  }

  unlock(element, andThen) {
    element.removeAttribute('rendersubtree');
    element.style.contentSize = '';
  }

  warn(element) {
    console.warn("Display locking not available");
    let div = document.createElement("div");
    div.style.color = "red";
    div.innerText = "No display locking";
    element.insertBefore(div, element.firstElementChild);
  }
}

export const locker = new Locker();
