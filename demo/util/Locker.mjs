export class Locker {
  constructor(size) {
    this.size = size || [10, 50];
  }

  lock(element, andThen) {
    return element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: this.size,
    }).then(andThen, reason => {console.log("Rejected: ", reason.message)});
  }

  update(element, andThen) {
    return element.displayLock.update().then(andThen, reason => {console.log("Rejected: ", reason.message)});
  }

  unlock(element, andThen) {
    return element.displayLock.commit().then(andThen, reason => {console.log("Rejected: ", reason)});
  }
}

export const locker = new Locker();
