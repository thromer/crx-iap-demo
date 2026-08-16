// Only one offscreen document may exist per extension at a time. hasDocument() plus creation
// is treated as a single in-flight operation here, or concurrent triggers race and throw.
let creating: Promise<void> | undefined;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Hosts the resource-access library, which issues its network requests from a dedicated Worker.',
      })
      .finally(() => {
        creating = undefined;
      });
  }
  await creating;
}
