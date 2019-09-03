export class Locker {
  constructor(size) {
    this.size = size || [10, 50];
  }

  lock(element, andThen) {
    let size = element.lockSize ? [10, element.lockSize] : this.size;
    return element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: size,
    }).then(andThen);
  }

  update(element, andThen) {
    return element.displayLock.update().then(andThen, reason => {console.log("Rejected: ", reason.message)});
  }

  unlock(element, andThen) {
    return element.displayLock.commit().then(andThen);
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
