export function words(wordCount, boldEvery) {
  let words = "";
  boldEvery = Math.floor(boldEvery);
  for (let i = 0; i < wordCount; i++) {
    if (boldEvery && (i % boldEvery == 0)) {
      words += " <span style='font-weigh:bold'>word</span>";
    } else {
      words += " word";
    }
  }
  return words;
}

export function divs(divCount, content) {
  let divs = [];
  for (let n = 0; n < divCount; n++) {
    let newDiv = document.createElement("div");
    newDiv.innerHTML = `${n} ${content}`;
    newDiv.id = "p" + n;
    divs.push(newDiv);
  }
  return divs;
}
