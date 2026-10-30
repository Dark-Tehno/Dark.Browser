(function () {
  "use strict";
  const target = new URLSearchParams(location.search).get('url') ?? '';
  const node = document.getElementById('blocked-url');
  if (node) node.textContent = target;
})();
