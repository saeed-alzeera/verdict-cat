/* Player icons for online rooms. The server only accepts ids from this list. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WordgridIcons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return ['🦊', '🐼', '🐙', '🦉', '🐢', '🦄', '🐝', '🦋', '🐳', '🦁', '🐸', '🐧',
          '🌵', '🍉', '🍄', '🌻', '🚀', '🎲', '🎯', '🎸', '⚡', '🔥', '🌙', '⭐'];
});
