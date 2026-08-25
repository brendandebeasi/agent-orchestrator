import { Loader2, Server, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import aoLogo from "../../../assets/ao-logo.svg";
import {
	connectToServer,
	normalizeServerAddress,
	serverLabelFromAddress,
	type ConnectionProbe,
} from "../lib/connect-server";
import { useRemoteServersStore } from "../stores/remote-servers-store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * Where the operator says which server to talk to.
 *
 * It fills the window rather than sitting in a dialog because there is nothing
 * behind it: until this succeeds the client has no daemon, so no board, no
 * sessions, and nothing to dismiss back to. It is deliberately the same shape
 * as the startup loader that it replaces, so a launch that needs a password
 * does not look like a different application.
 *
 * The form stays filled and editable through every failure. An operator who
 * mistyped one character of a tailnet hostname should fix that character, not
 * retype the address; and one whose password was rejected should not also have
 * to re-enter the address that was right.
 */
export function ConnectServerScreen({
	/**
	 * Address to start from — the server the client was configured for, or the
	 * one it just lost. Empty when the operator has never connected.
	 */
	initialAddress = "",
	/** Why the screen is being shown, when it is not simply the first launch. */
	initialProblem = null,
	/** Called once a probe succeeds and the client has been re-aimed. */
	onConnected,
}: {
	initialAddress?: string;
	initialProblem?: ConnectionProbe | null;
	onConnected?: (baseUrl: string) => void;
}) {
	const { t } = useTranslation();
	const [address, setAddress] = useState(initialAddress);
	const [password, setPassword] = useState("");
	const [remember, setRemember] = useState(true);
	const [busy, setBusy] = useState(false);
	// Null means "nothing has failed yet", which is not the same as "the last
	// attempt succeeded" — the screen unmounts on success.
	const [problem, setProblem] = useState<ConnectionProbe | null>(initialProblem);
	const [addressInvalid, setAddressInvalid] = useState(false);

	const servers = useRemoteServersStore((state) => state.servers);
	const loadServers = useRemoteServersStore((state) => state.load);
	const saveServer = useRemoteServersStore((state) => state.save);
	const removeServer = useRemoteServersStore((state) => state.remove);
	const credentialFor = useRemoteServersStore((state) => state.credentialFor);

	useEffect(() => {
		void loadServers();
	}, [loadServers]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const baseUrl = normalizeServerAddress(address);
		if (baseUrl === null) {
			// Not a probe outcome: nothing was attempted, because there was
			// nothing to attempt it against.
			setAddressInvalid(true);
			setProblem(null);
			return;
		}
		setAddressInvalid(false);
		setBusy(true);
		setProblem(null);
		try {
			const label = serverLabelFromAddress(baseUrl);
			const probe = await connectToServer({ baseUrl, credential: password, label });
			if (probe.outcome !== "connected") {
				setProblem(probe);
				return;
			}
			// Recorded only after the server accepted it. Saving on submit would
			// persist passwords that do not work, and an address that does not
			// answer.
			await saveServer(
				{ baseUrl, label, lastConnectedAt: new Date().toISOString() },
				remember ? password : null,
			);
			onConnected?.(baseUrl);
		} finally {
			setBusy(false);
		}
	}

	/**
	 * Fill the form from a saved server, including its password when one is
	 * held, and leave the operator to press Connect. It does not connect for
	 * them: a saved server that has since moved or changed its password would
	 * otherwise fail with no visible cause between the click and the error.
	 */
	async function fillFrom(baseUrl: string) {
		setAddress(baseUrl);
		setAddressInvalid(false);
		setProblem(null);
		setPassword((await credentialFor(baseUrl)) ?? "");
	}

	return (
		<div
			className="flex h-full w-full items-center justify-center bg-background text-foreground"
			data-testid="connect-server-screen"
		>
			<div className="flex w-full max-w-96 flex-col items-stretch px-6">
				<div className="flex flex-col items-center text-center">
					<img alt="" aria-hidden="true" className="h-16 w-16 object-contain" src={aoLogo} />
					<h1 className="mt-4 text-base font-semibold tracking-tight">{t("connectServer.title")}</h1>
					<p className="mt-1 text-md-sm text-muted-foreground">{t("connectServer.subtitle")}</p>
				</div>

				<form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="connectServerAddress">{t("connectServer.addressLabel")}</Label>
						<Input
							aria-describedby="connectServerAddressHint"
							aria-invalid={addressInvalid || undefined}
							autoComplete="off"
							autoFocus
							id="connectServerAddress"
							onChange={(event) => {
								setAddress(event.target.value);
								setAddressInvalid(false);
							}}
							placeholder={t("connectServer.addressPlaceholder")}
							spellCheck={false}
							value={address}
						/>
						<p className="text-xs text-muted-foreground" id="connectServerAddressHint">
							{t("connectServer.addressHint")}
						</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="connectServerPassword">{t("connectServer.passwordLabel")}</Label>
						<Input
							autoComplete="current-password"
							id="connectServerPassword"
							onChange={(event) => setPassword(event.target.value)}
							type="password"
							value={password}
						/>
					</div>

					<label className="flex items-center gap-2 text-md-sm text-muted-foreground">
						<input
							checked={remember}
							className="size-4 accent-primary"
							onChange={(event) => setRemember(event.target.checked)}
							type="checkbox"
						/>
						{t("connectServer.remember")}
					</label>

					{/* One region for every failure, so a second attempt replaces the
					    first message instead of stacking a new one beneath it. */}
					<div aria-live="polite" role="status">
						{addressInvalid ? <ProblemText text={t("connectServer.errorAddressInvalid")} /> : null}
						{problem ? <ProblemText text={t(problemMessageKey(problem))} /> : null}
					</div>

					<Button className="w-full" disabled={busy} type="submit">
						{busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
						{busy ? t("connectServer.connecting") : t("connectServer.connect")}
					</Button>
				</form>

				{servers.length > 0 ? (
					<div className="mt-8 flex flex-col gap-1">
						<p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							{t("connectServer.savedHeading")}
						</p>
						{servers.map((server) => (
							<div className="flex items-center gap-1" key={server.baseUrl}>
								<button
									className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-md-sm transition-colors hover:bg-interactive-hover"
									onClick={() => void fillFrom(server.baseUrl)}
									type="button"
								>
									<Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate">{server.label}</span>
								</button>
								<Button
									aria-label={t("connectServer.forget", { server: server.label })}
									onClick={() => void removeServer(server.baseUrl)}
									size="icon"
									type="button"
									variant="ghost"
								>
									<Trash2 aria-hidden="true" />
								</Button>
							</div>
						))}
						<p className="px-1 pt-1 text-xs text-muted-foreground">{t("connectServer.forgetHint")}</p>
					</div>
				) : null}
			</div>
		</div>
	);
}

function ProblemText({ text }: { text: string }) {
	return (
		<p className="flex items-start gap-2 text-md-sm text-destructive">
			<TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
			<span>{text}</span>
		</p>
	);
}

/**
 * The message for each failure, chosen so the operator knows which of the two
 * fields to look at. This is the whole reason `probeServer` enumerates outcomes
 * rather than returning a boolean.
 */
function problemMessageKey(probe: ConnectionProbe) {
	switch (probe.outcome) {
		case "unreachable":
			return "connectServer.errorUnreachable" as const;
		case "rejected":
			return "connectServer.errorRejected" as const;
		case "lockedOut":
			return "connectServer.errorLockedOut" as const;
		case "notADaemon":
			return "connectServer.errorNotADaemon" as const;
		case "connected":
			// Unreachable in practice; the screen unmounts on success. Returning
			// the generic string beats asserting and blanking the region.
			return "connectServer.errorUnreachable" as const;
	}
}
