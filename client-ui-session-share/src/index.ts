/**
 * Session sharing for the anago Web UI, node half. The empty apply exists so
 * the package holds a Loader row the client module system serves the browser
 * half for; the behavior itself is the `./client` export.
 * @module @anago-harness/client-ui-session-share
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
