import * as Params from './Params.mjs';
export class Locker {
  constructor(size) {
    this.size = size || [10, 50];
  }

  lock(element, andThen) {
    let size = element.lockSize ? [10, element.lockSize] : this.size;
    element.style.containIntrinsicSize = `${size[0]}px ${size[1]}px`;
    element.style.contentVisibility = "hidden";
  }

  update(element, andThen) {
    return element.updateRendering();
  }

  unlock(element, andThen) {
    element.style.contentVisibility = "";
    element.style.containIntrinsicSize = "";
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
