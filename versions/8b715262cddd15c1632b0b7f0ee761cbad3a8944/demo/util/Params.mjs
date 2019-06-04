export function get(param, parse) {
  let params = (new URL(document.location)).searchParams;
  let value = parse(params.get(param));
  let placeholder = document.getElementById(param + "-placeholder");
  if (placeholder) {
    placeholder.innerText = value;
  }
  return value;
}
