import type React from "react";
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPutJson } from "../hooks/useApi.js";
import { AppIcon } from "./ui/AppIcon.js";

export const USER_PROFILE_UPDATED_EVENT = "octopus:user-profile-updated";

interface UserProfile {
	displayName: string | null;
	preferredLanguage?: string;
}

interface UserProfileResponse {
	profile: UserProfile | null;
}

interface UserMenuProps {
	onOpenSettings: () => void;
	compact?: boolean;
}

const LANGUAGES = [
	{ value: "es", label: "Español" },
	{ value: "en", label: "English" },
	{ value: "pt", label: "Português" },
	{ value: "auto", label: "Automático" },
];

function profileInitial(name: string): string {
	return name.trim().charAt(0).toUpperCase() || "U";
}

export const UserMenu: React.FC<UserMenuProps> = ({
	onOpenSettings,
	compact = false,
}) => {
	const rootRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [languageOpen, setLanguageOpen] = useState(false);
	const [profile, setProfile] = useState<UserProfile>({
		displayName: null,
		preferredLanguage: "es",
	});
	const [savingLanguage, setSavingLanguage] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hasAuthenticatedSession = Boolean(
		sessionStorage.getItem("octopus-api-key")?.trim(),
	);

	useEffect(() => {
		const loadProfile = () => {
			apiGet<UserProfileResponse>("/api/memory/profile")
				.then((response) => {
					if (response.profile) setProfile(response.profile);
				})
				.catch(() => undefined);
		};
		const handleProfileUpdate = (event: Event) => {
			const detail = (event as CustomEvent<UserProfile>).detail;
			if (detail) setProfile(detail);
			else loadProfile();
		};
		loadProfile();
		window.addEventListener(USER_PROFILE_UPDATED_EVENT, handleProfileUpdate);
		return () =>
			window.removeEventListener(USER_PROFILE_UPDATED_EVENT, handleProfileUpdate);
	}, []);

	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	const displayName = profile.displayName?.trim() || "Usuario Local";
	const language = profile.preferredLanguage || "es";
	const languageLabel =
		LANGUAGES.find((entry) => entry.value === language)?.label ?? language;

	const changeLanguage = async (value: string) => {
		setSavingLanguage(true);
		setError(null);
		try {
			const response = (await apiPutJson("/api/memory/profile", {
				preferredLanguage: value,
			})) as { profile?: UserProfile };
			const next = response.profile ?? { ...profile, preferredLanguage: value };
			setProfile(next);
			window.dispatchEvent(
				new CustomEvent(USER_PROFILE_UPDATED_EVENT, { detail: next }),
			);
			setLanguageOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingLanguage(false);
		}
	};

	const logout = () => {
		if (!hasAuthenticatedSession) return;
		sessionStorage.removeItem("octopus-api-key");
		localStorage.removeItem("octopus-active-tab");
		window.location.reload();
	};

	return (
		<div ref={rootRef} className={`user-menu${compact ? " is-compact" : ""}`}>
			{open && (
				<div className="user-menu-popover" role="menu" aria-label="Menú de usuario">
					<div className="user-menu-heading">
						<span className="user-menu-heading-avatar">
							{profileInitial(displayName)}
						</span>
						<span>
							<strong>{displayName}</strong>
							<small>Octopus auto-hospedado</small>
						</span>
					</div>

					<button
						type="button"
						className="user-menu-item"
						role="menuitem"
						onClick={() => setLanguageOpen((current) => !current)}
					>
						<AppIcon name="globe" size={17} />
						<span className="user-menu-item-copy">
							<strong>Idioma</strong>
							<small>{languageLabel}</small>
						</span>
						<AppIcon name={languageOpen ? "chevronDown" : "chevronRight"} size={14} />
					</button>

					{languageOpen && (
						<div className="user-menu-languages" aria-label="Seleccionar idioma">
							{LANGUAGES.map((entry) => (
								<button
									key={entry.value}
									type="button"
									className={entry.value === language ? "is-active" : ""}
									disabled={savingLanguage}
									onClick={() => void changeLanguage(entry.value)}
								>
									<span>{entry.label}</span>
									{entry.value === language && <AppIcon name="check" size={14} />}
								</button>
							))}
						</div>
					)}

					<button
						type="button"
						className="user-menu-item"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onOpenSettings();
						}}
					>
						<AppIcon name="settings" size={17} />
						<span className="user-menu-item-copy">
							<strong>Ajustes</strong>
							<small>Abre el centro de configuración</small>
						</span>
					</button>

					<div className="user-menu-separator" />

					<button
						type="button"
						className="user-menu-item"
						role="menuitem"
						disabled
						title="Octopus todavía no tiene perfiles multiusuario aislados"
					>
						<AppIcon name="user" size={17} />
						<span className="user-menu-item-copy">
							<strong>Cambiar de usuario</strong>
							<small>Requiere perfiles multiusuario</small>
						</span>
					</button>

					<button
						type="button"
						className="user-menu-item is-danger"
						role="menuitem"
						disabled={!hasAuthenticatedSession}
						title={
							hasAuthenticatedSession
								? "Cerrar la sesión autenticada"
								: "La instalación local no exige una sesión"
						}
						onClick={logout}
					>
						<AppIcon name="logout" size={17} />
						<span className="user-menu-item-copy">
							<strong>Cerrar sesión</strong>
							<small>
								{hasAuthenticatedSession
									? "Elimina la clave de esta sesión"
									: "Sin sesión requerida en modo local"}
							</small>
						</span>
					</button>

					{error && <div className="user-menu-error">{error}</div>}
				</div>
			)}

			<button
				type="button"
				className="user-menu-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<span className="user-menu-trigger-avatar">{profileInitial(displayName)}</span>
				<span className="user-menu-trigger-copy">
					<strong>{displayName}</strong>
					<small>Auto-hospedado</small>
				</span>
				<AppIcon name={open ? "chevronDown" : "chevronRight"} size={15} />
			</button>
		</div>
	);
};
