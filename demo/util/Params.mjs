export function get(param, parse, status) {
  let params = (new URL(document.location)).searchParams;
  let value = parse(params.get(param));
  if (status) {
    let placeholder = status.getRootNode().getElementById(param + "-placeholder");
    if (!placeholder) {
      let div = document.createElement("div");
      div.innerHTML = `<code>${param}=<span id=${param}-placeholder>nnn</span></code>`;
      status.appendChild(div);
      placeholder = status.getRootNode().getElementById(param + "-placeholder");
    }
    placeholder.innerText = value;
  }
  return value;
}
