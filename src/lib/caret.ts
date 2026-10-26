// Where the caret is inside a textarea, in px relative to the textarea's top-left corner
// (scroll included). Textareas don't expose this, so copy the text up to the caret into
// an off-screen div styled the same way and measure a marker at its end.

const COPIED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "wordSpacing", "textIndent", "tabSize",
] as const;

export function caretCoords(el: HTMLTextAreaElement, index: number): { top: number; left: number; height: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of COPIED) mirror.style[p] = style[p];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    overflow: "hidden",
  });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const out = { top: marker.offsetTop - el.scrollTop, left: marker.offsetLeft - el.scrollLeft, height: lineHeight };
  mirror.remove();
  return out;
}
