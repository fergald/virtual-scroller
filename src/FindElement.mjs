export const BIAS_LOW = Symbol("BIAS_LOW");
export const BIAS_HIGH = Symbol("BIAS_HIGH");

// Binary searches inside the list |elements| to find which element's
// vertical bounds contain |offset|.  Assumes that the elements are
// already sorted in increasing pixel order.  |bias| controls what
// happens if |offset| is not contained within any element.  If |bias|
// is BIAS_LOW, then this selects the lower element nearest |offset|,
// otherwise it selects the higher element.
function findElementIndex(elements, offset, bias) {
  let low = 0;
  let high = elements.length - 1;
  let [high_dec, low_inc] = bias === BIAS_LOW ? [1, 0] : [0, 1];
  let i;
  while (true) {
    if (low === high) {
      return low;
    }
    i = Math.floor((low + high) / 2); // eslint-disable-line no-magic-numbers
    const element = elements[i];
    const rect = element.getBoundingClientRect();
    if (rect.top > offset) {
      // The entire rect is > offset.
      high = Math.max(i - high_dec, low);
    } else if (rect.bottom < offset) {
      // The entire rect is < offset.
      low = Math.min(i + low_inc, high);
    } else {
      // The rect contains offset.
      break;
    }
  }
  return i;
}

export function findElement(elements, offset) {
  return elements[findElementIndex(elements, offset)];
}
