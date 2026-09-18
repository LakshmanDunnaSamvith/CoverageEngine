// Browser-side DOM extraction, injected via page.evaluate().
// Returns interactive elements plus their nearest landmark container so the
// Python side can group them into "components" and derive stable IDs.
// This mirrors the ID strategy in fingerprint.py / shared/fingerprint.js.
() => {
  const INTERACTIVE =
    "a[href], button, input, select, textarea, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [onclick], [data-nav], [data-coverage-action]";
  const LANDMARKS = "form, nav, section, aside, header, main, [role='region'], [data-coverage-id], [data-testid]";

  function cssPath(node) {
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && parts.length < 6) {
      let seg = el.tagName.toLowerCase();
      if (el.id) {
        seg += `#${el.id}`;
        parts.unshift(seg);
        break;
      }
      const parent = el.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(c => c.tagName === el.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
      parts.unshift(seg);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  function visible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (rect.width > 0 || rect.height > 0)
    );
  }

  function label(el) {
    const text =
      (el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.value ||
        el.textContent ||
        "")
        .replace(/\s+/g, " ")
        .trim();
    return text.slice(0, 80);
  }

  function containerKey(el) {
    const landmark = el.closest(LANDMARKS);
    if (!landmark) return "page";
    return (
      landmark.getAttribute("data-testid") ||
      landmark.getAttribute("data-coverage-id") ||
      landmark.getAttribute("aria-label") ||
      landmark.id ||
      (landmark.className && String(landmark.className).split(" ")[0]) ||
      landmark.tagName.toLowerCase()
    );
  }

  const seen = new Set();
  const elements = [];
  document.querySelectorAll(INTERACTIVE).forEach(el => {
    if (!visible(el)) return;
    const key = cssPath(el);
    if (seen.has(key)) return;
    seen.add(key);
    elements.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      id: el.id || null,
      name: el.getAttribute("name") || null,
      testid: el.getAttribute("data-testid") || null,
      coverageId: el.getAttribute("data-coverage-id") || el.getAttribute("data-coverage-action") || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      href: el.getAttribute("href") || null,
      text: label(el),
      container: containerKey(el),
      cssPath: key,
    });
  });

  const links = [...document.querySelectorAll("a[href]")]
    .map(a => a.getAttribute("href"))
    .filter(Boolean);

  return {
    pathname: location.pathname,
    title: document.title,
    elements,
    links,
  };
}
