export function installPlayerScreen(
  emulator,
  dimensions = { width: 160, height: 144 },
) {
  const canvas = emulator.canvas;
  const parent = canvas.parentElement;
  parent.style.position = "relative";
  const viewport = document.createElement("div");
  viewport.className = "link-player-viewport";
  Object.assign(viewport.style, {
    position: "absolute",
    overflow: "hidden",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    visibility: "hidden",
  });
  parent.append(viewport);
  viewport.append(canvas);
  let player = null;
  function resize() {
    const columns = dimensions.columns ?? 2, rows = dimensions.rows ?? 1;
    const height = Math.min(
      parent.clientHeight,
      (parent.clientWidth * dimensions.height) / dimensions.width,
    );
    const width = (height * dimensions.width) / dimensions.height;
    Object.assign(viewport.style, {
      width: `${width}px`,
      height: `${height}px`,
    });
    Object.assign(canvas.style, {
      width: `${width * columns}px`,
      height: `${height * rows}px`,
      left: `${-(player % columns) * width || 0}px`,
      top: `${-Math.floor(player / columns) * height || 0}px`,
      transform: "none",
    });
  }
  const observer = new ResizeObserver(resize);
  observer.observe(parent);
  resize();
  return {
    select(role) {
      player = role;
      viewport.style.visibility = role === null ? "hidden" : "visible";
      resize();
    },
    destroy() {
      observer.disconnect();
    },
  };
}
