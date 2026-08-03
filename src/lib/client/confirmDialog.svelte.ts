// A single shared confirm-dialog store so every "are you sure?" moment in the
// app uses the same pixel-styled overlay (ConfirmDialogHost.svelte, mounted
// once in the root layout) instead of the browser's native confirm(), which
// looks completely different from the rest of the UI.
class ConfirmDialogStore {
	open = $state(false);
	message = $state('');
	confirmLabel = $state('确认');
	// null = alert mode: no cancel button, since there's nothing to cancel
	// (e.g. "the room was closed") - just one button to acknowledge.
	cancelLabel = $state<string | null>('取消');
	private resolver: ((value: boolean) => void) | null = null;

	ask(
		message: string,
		opts?: { confirmLabel?: string; cancelLabel?: string | null }
	): Promise<boolean> {
		// A caller should never be left with a permanently-pending promise if a
		// second ask() arrives while one is already open - resolve the stale
		// one as "cancelled" before replacing it.
		this.resolver?.(false);
		this.message = message;
		this.confirmLabel = opts?.confirmLabel ?? '确认';
		this.cancelLabel = opts?.cancelLabel === undefined ? '取消' : opts.cancelLabel;
		this.open = true;
		return new Promise((resolve) => {
			this.resolver = resolve;
		});
	}

	respond(value: boolean): void {
		this.open = false;
		const resolve = this.resolver;
		this.resolver = null;
		resolve?.(value);
	}
}

export const confirmDialogStore = new ConfirmDialogStore();

/** Shows the shared pixel-styled confirm dialog and resolves once the user
 * picks confirm (true) or cancel/backdrop-dismiss (false). */
export function askConfirm(
	message: string,
	opts?: { confirmLabel?: string; cancelLabel?: string }
): Promise<boolean> {
	return confirmDialogStore.ask(message, opts);
}

/** Single-button "OK" style notice, blocking until acknowledged - for events
 * the user needs to actually see and register (e.g. the room they're in was
 * just closed), where a transient auto-clearing toast could easily be missed
 * entirely if something else (like navigating away) happens right after. */
export function showAlert(message: string, confirmLabel = '好的'): Promise<void> {
	return confirmDialogStore.ask(message, { confirmLabel, cancelLabel: null }).then(() => undefined);
}
