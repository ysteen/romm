export function nativeTarget({
  userAgent = "",
  platform = "",
  architecture = "",
  bitness = "",
  wow64 = false,
  maxTouchPoints = 0,
} = {}) {
  const text = `${platform} ${userAgent}`;
  if (/Android/i.test(text)) {
    if (/x86|i[3-6]86/i.test(architecture || text))
      return bitness === "32" || /i[3-6]86/.test(text)
        ? "android-x86"
        : "android-x86_64";
    return bitness === "32" || /armv7|armeabi/i.test(text)
      ? "android-armeabi-v7a"
      : "android-arm64-v8a";
  }
  if (/Windows|Win32|Win64/i.test(text)) {
    if (/arm|aarch64/i.test(architecture || text)) return "windows-arm64";
    if (
      !wow64 &&
      (bitness === "32" || /Windows NT.*(?:i[3-6]86|x86[;)])/i.test(text))
    )
      return "windows-x86";
    return "windows-x86_64";
  }
  if (
    /iPhone|iPad|iPod|Mac/i.test(text) ||
    (platform === "MacIntel" && maxTouchPoints > 1)
  )
    return null;
  if (/Linux|X11/i.test(text) && /x86_64|amd64/i.test(text))
    return "linux-x86_64";
  return null;
}

export async function detectNativeTarget(browser = navigator) {
  let hints = {};
  try {
    if (browser.userAgentData?.getHighEntropyValues) {
      let timer;
      try {
        hints = await Promise.race([
          browser.userAgentData.getHighEntropyValues([
            "architecture",
            "bitness",
            "wow64",
          ]),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({}), 750);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    /* Client hints are optional in browsers that restrict them. */
  }
  return nativeTarget({
    userAgent: browser.userAgent,
    maxTouchPoints: browser.maxTouchPoints,
    platform: browser.userAgentData?.platform || browser.platform,
    ...hints,
  });
}

export async function installNativeDownloads({
  catalog,
  select,
  download,
  infoDownload,
  infoHint,
  hint,
  instructions,
  browser = navigator,
}) {
  const builds = catalog.downloads || {};
  select.replaceChildren(new Option("Choose your RetroArch platform", ""));
  for (const [id, build] of Object.entries(builds))
    select.append(new Option(build.label, id));
  function update() {
    const build = builds[select.value];
    const coreInfo = catalog.native.coreInfo;
    if (infoDownload && infoHint) {
      infoDownload.hidden = infoHint.hidden = !build || !coreInfo;
      if (build && coreInfo) {
        infoDownload.href = coreInfo.path;
        infoDownload.download = coreInfo.path.split("/").at(-1);
      } else {
        infoDownload.removeAttribute("href");
      }
    }
    download.hidden = !build;
    if (build) {
      download.href = build.path;
      download.download = build.path.split("/").at(-1);
      download.textContent = `Download core (${build.label})`;
      hint.textContent =
        "Match the architecture of your RetroArch app. You can change this selection if browser detection differs.";
    } else {
      download.removeAttribute("href");
      hint.textContent =
        "Choose a supported platform, or join this room in your browser.";
    }
  }
  select.onchange = update;
  update();
  instructions.href = catalog.native.buildInstructions;
  const detected = await detectNativeTarget(browser);
  if (!select.value && builds[detected]) select.value = detected;
  update();
}
