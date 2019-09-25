import * as Params from './Params.mjs';
export class Locker {
  constructor(size, rs) {
    this.size = size || [10, 50];
    this.rs = rs;
  }

  lock(element, andThen) {
    let size = element.lockSize ? [10, element.lockSize] : this.size;
    if (this.rs) {
      element.setAttribute('rendersubtree', 'invisible activatable');
      element.style.contentSize = `${size[0]}px ${size[1]}px`;
    } else {
      return element.displayLock.acquire({
        timeout: Infinity,
        activatable: true,
        size: size,
      }).then(andThen);
    }
  }

  update(element, andThen) {
    return element.displayLock.update().then(andThen, reason => {console.log("Rejected: ", reason.message)});
  }

  unlock(element, andThen) {
    if (this.rs) {
      element.removeAttribute('rendersubtree');
      element.style.contentSize = '';
    } else {
      return element.displayLock.commit().then(andThen);
    }
  }

  warn(element) {
    console.warn("Display locking not available");
    let div = document.createElement("div");
    div.style.color = "red";
    div.innerText = "No display locking";
    element.insertBefore(div, element.firstElementChild);
  }
}

const rs = Params.get("renderSubtree", (p) => { return parseInt(p) || 0}, statusDiv);
export const locker = new Locker(rs);
