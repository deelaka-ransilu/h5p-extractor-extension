// This file is loaded with "world": "MAIN", meaning it runs in the page's
// actual JS context and CAN see window.H5PIntegration. It cannot use
// chrome.runtime, so it just relays data via postMessage to content.js,
// which runs in the isolated world alongside the extension APIs.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'H5P_EXTRACTOR_REQUEST') return;

  const integration = window.H5PIntegration;
  if (!integration || !integration.contents) {
    window.postMessage({ type: 'H5P_EXTRACTOR_RESPONSE', error: 'No H5PIntegration found on this page.' }, '*');
    return;
  }

  const contentKey = Object.keys(integration.contents)[0];
  const entry = integration.contents[contentKey];
  if (!entry || !entry.jsonContent) {
    window.postMessage({ type: 'H5P_EXTRACTOR_RESPONSE', error: 'H5PIntegration found, but no jsonContent inside it.' }, '*');
    return;
  }

  window.postMessage({
    type: 'H5P_EXTRACTOR_RESPONSE',
    jsonContent: entry.jsonContent,
    contentUrl: entry.contentUrl,
    title: (entry.metadata && entry.metadata.title) || document.title,
  }, '*');
});
