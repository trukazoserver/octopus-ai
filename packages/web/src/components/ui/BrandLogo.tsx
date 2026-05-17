import type React from "react";
import { useState } from "react";

export interface BrandLogoProps {
	name: string;
	domain?: string;
	src?: string;
	sources?: string[];
	size?: number;
	className?: string;
	fallbackLabel?: string;
}

function initials(name: string): string {
	return name
		.split(/\s+|\//)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase())
		.filter(Boolean)
		.join("");
}

export function faviconSource(domain: string): string {
	return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
	name,
	domain,
	src,
	sources,
	size = 24,
	className,
	fallbackLabel,
}) => {
	const sourceList = [
		...(src ? [src] : []),
		...(sources ?? []),
		...(domain ? [faviconSource(domain)] : []),
	];
	const [index, setIndex] = useState(0);
	const [loaded, setLoaded] = useState(false);
	const current = sourceList[index];

	return (
		<span
			className={`brand-logo${className ? ` ${className}` : ""}`}
			style={{ width: size, height: size, minWidth: size }}
			aria-hidden="true"
		>
			<span className="brand-logo-fallback">
				{fallbackLabel ?? initials(name)}
			</span>
			{current && (
				<img
					src={current}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					style={{ opacity: loaded ? 1 : 0 }}
					onLoad={(event) => {
						const img = event.currentTarget;
						setLoaded(img.naturalWidth > 0 && img.naturalHeight > 0);
					}}
					onError={() => {
						setLoaded(false);
						setIndex((value) => value + 1);
					}}
				/>
			)}
		</span>
	);
};
