function nextSiblings(element, count, direction, siblings) {
  while (count) {
    element = direction == -1 ? element.previousSibling : element.nextSibling;
    if (element === null) {
      break;
    }
    siblings.push(element);
    count--;
  }
}

export function neighbours(element, range) {
  let elements = [element];
  nextSiblings(element, range, -1, elements);
  nextSiblings(element, range, +1, elements);
  return elements;
}
