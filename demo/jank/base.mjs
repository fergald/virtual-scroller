import * as Words from '../util/Words.mjs';
import * as Locker from '../util/Locker.mjs'

export function populate(vc) {
  if (vc.setFromUrl) {
    vc.setFromUrl(document.location);
  } else {
    console.warn("Not calling vs.setFromUrl on", vc);
  }

  let params = (new URL(document.location)).searchParams;
  let wordCount = parseInt(params.get("words")) || 50;
  let divCount = parseInt(params.get("divs")) || 10000;
  let words = Words.words(wordCount);
  let i = 0;
  // Will be NaN if not supplied and i>=lockFrom will never be true.
  let lockFrom = parseInt(params.get("lockFrom"));
  for (const div of Words.divs(divCount, words)) {
    vc.appendChild(div);
    if (i >= lockFrom) {
      div.displayLock.acquire({
        timeout: Infinity,
        activatable: true,
        size: [10, 10],
      }).then(null, reason => {console.log("Rejected: ", reason.message)});
    }
  }
}

function jump() {
  let elements = contentDiv.children[0].children;
  elements[elements.length - 1].scrollIntoView();
}
window.jump = jump;

function resize() {
  contentDiv.style.width = contentDiv.style.width == "200px" ? "" : "200px";
}
window.resize = resize;

function logInfo() {
  vc.logInfo();
}
window.logInfo = logInfo;

function onChangeUseScrollEvents() {
  if (vc) {
    vc.setUseScrollEvents(useScrollEvents.checked, contentDiv);
  }
}
window.onChangeUseScrollEvents = onChangeUseScrollEvents;

function onChangeUseForcedLayouts() {
  if (vc) {
    vc.setUseScrollEvents(useForcedLayouts.checked, contentDiv);
  }
}
window.onChangeUseForcedLayouts = onChangeUseForcedLayouts;
