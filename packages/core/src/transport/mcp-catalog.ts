export interface MCPCatalogEntry {
	name: string;
	displayName: string;
	description: string;
	category: string;
	icon: string;
	tools: string[];
	config: {
		command: string;
		args: string[];
		env?: Record<string, string>;
	};
	requiresApiKey?: string;
	homepage: string;
}

export const MCP_CATALOG: MCPCatalogEntry[] = [
	{
		name: "zai-web-reader",
		displayName: "Web Reader",
		description:
			"Lee contenido de URLs, extrae título, cuerpo, metadatos y enlaces.",
		category: "Z.ai",
		icon: "https://cdn.simpleicons.org/internetexplorer/2563eb",
		tools: ["webReader"],
		config: {
			command: "npx",
			args: [
				"-y",
				"@anthropic-ai/mcp-remote@latest",
				"https://open.bigmodel.cn/api/mcp/web_reader/mcp",
				"--header",
				"Authorization:Bearer ${ZHIPU_API_KEY}",
			],
			env: {},
		},
		requiresApiKey: "Z.AI API Key (ZHIPU_API_KEY)",
		homepage: "https://open.bigmodel.cn/",
	},
	{
		name: "zai-web-search",
		displayName: "Web Search",
		description:
			"Búsqueda web que retorna títulos, URLs y resúmenes de resultados.",
		category: "Z.ai",
		icon: "https://cdn.simpleicons.org/google/4285F4",
		tools: ["webSearchPrime"],
		config: {
			command: "npx",
			args: [
				"-y",
				"@anthropic-ai/mcp-remote@latest",
				"https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
				"--header",
				"Authorization:Bearer ${ZHIPU_API_KEY}",
			],
			env: {},
		},
		requiresApiKey: "Z.AI API Key (ZHIPU_API_KEY)",
		homepage: "https://open.bigmodel.cn/",
	},
	{
		name: "zai-zread",
		displayName: "ZRead (GitHub Repos)",
		description:
			"Busca y lee documentación, issues y archivos de repositorios GitHub.",
		category: "Z.ai",
		icon: "https://cdn.simpleicons.org/readthedocs/8CA1AF",
		tools: ["search_doc", "get_repo_structure", "read_file"],
		config: {
			command: "npx",
			args: [
				"-y",
				"@anthropic-ai/mcp-remote@latest",
				"https://open.bigmodel.cn/api/mcp/zread/mcp",
				"--header",
				"Authorization:Bearer ${ZHIPU_API_KEY}",
			],
			env: {},
		},
		requiresApiKey: "Z.AI API Key (ZHIPU_API_KEY)",
		homepage: "https://open.bigmodel.cn/",
	},
	{
		name: "zai-vision",
		displayName: "Vision & Analysis",
		description:
			"Análisis de imágenes, OCR, diagnóstico de errores, diagramas técnicos y visualizaciones de datos.",
		category: "Z.ai",
		icon: "https://cdn.simpleicons.org/openvision/0078D7",
		tools: [
			"ui_to_artifact",
			"extract_text_from_screenshot",
			"diagnose_error_screenshot",
			"understand_technical_diagram",
			"analyze_data_visualization",
			"ui_diff_check",
			"image_analysis",
			"video_analysis",
		],
		config: {
			command: "npx",
			args: ["-y", "@z_ai/mcp-server"],
			env: {
				Z_AI_API_KEY: "${ZHIPU_API_KEY}",
				Z_AI_MODE: "ZHIPU",
			},
		},
		requiresApiKey: "Z.AI API Key (ZHIPU_API_KEY)",
		homepage: "https://open.bigmodel.cn/",
	},
	{
		name: "filesystem",
		displayName: "Filesystem",
		description:
			"Lee, escribe y busca archivos en el sistema de archivos local.",
		category: "Popular",
		icon: "https://cdn.simpleicons.org/files/ffffff",
		tools: [
			"read_file",
			"write_file",
			"search_files",
			"list_directory",
			"create_directory",
			"move_file",
			"get_file_info",
			"list_allowed_directories",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
	},
	{
		name: "github",
		displayName: "GitHub",
		description: "Gestiona repos, PRs, issues y más en GitHub.",
		category: "Popular",
		icon: "https://cdn.simpleicons.org/github/ffffff",
		tools: [
			"create_or_update_file",
			"search_repositories",
			"create_repository",
			"get_file_contents",
			"push_files",
			"create_issue",
			"create_pull_request",
			"search_code",
			"search_issues",
			"search_users",
			"list_commits",
			"list_issues",
			"list_pull_requests",
			"get_pull_request",
			"create_pull_request_review",
			"merge_pull_request",
			"get_pull_request_comments",
			"get_pull_request_reviews",
			"get_pull_request_files",
			"get_pull_request_status",
			"update_pull_request_branch",
			"fork_repository",
			"create_branch",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: {
				GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}",
			},
		},
		requiresApiKey: "GitHub Personal Access Token (GITHUB_TOKEN)",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/github",
	},
	{
		name: "sqlite",
		displayName: "SQLite",
		description: "Lee y escribe en bases de datos SQLite locales.",
		category: "Popular",
		icon: "https://cdn.simpleicons.org/sqlite/003B57",
		tools: [
			"read_query",
			"write_query",
			"create_table",
			"list_tables",
			"describe_table",
		],
		config: {
			command: "npx",
			args: [
				"-y",
				"@modelcontextprotocol/server-sqlite",
				"--db-path",
				"/path/to/db.sqlite",
			],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
	},
	{
		name: "brave-search",
		displayName: "Brave Search",
		description: "Búsqueda web usando Brave Search API.",
		category: "Búsqueda",
		icon: "https://cdn.simpleicons.org/brave/FB542B",
		tools: ["brave_web_search", "brave_local_search"],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-brave-search"],
			env: {
				BRAVE_API_KEY: "${BRAVE_API_KEY}",
			},
		},
		requiresApiKey: "Brave Search API Key",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
	},
	{
		name: "memory",
		displayName: "Memory (Knowledge Graph)",
		description:
			"Almacena y recupera entidades y relaciones en un knowledge graph persistente.",
		category: "Datos",
		icon: "https://cdn.simpleicons.org/neo4j/4581C3",
		tools: [
			"create_entities",
			"create_relations",
			"add_observations",
			"delete_entities",
			"delete_observations",
			"delete_relations",
			"read_graph",
			"search_nodes",
			"open_nodes",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-memory"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
	},
	{
		name: "fetch",
		displayName: "Fetch (HTTP)",
		description: "Realiza peticiones HTTP GET/POST a URLs arbitrarias.",
		category: "Datos",
		icon: "https://cdn.simpleicons.org/curl/F74A05",
		tools: ["fetch"],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-fetch"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
	},
	{
		name: "puppeteer",
		displayName: "Puppeteer (Browser)",
		description:
			"Automatiza el navegador Chrome para scraping, screenshots y testing.",
		category: "Browser",
		icon: "https://cdn.simpleicons.org/puppeteer/40B5A4",
		tools: [
			"puppeteer_navigate",
			"puppeteer_screenshot",
			"puppeteer_click",
			"puppeteer_fill",
			"puppeteer_evaluate",
			"puppeteer_close",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-puppeteer"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
	},
	{
		name: "sequential-thinking",
		displayName: "Sequential Thinking",
		description: "Razonamiento paso a paso para resolver problemas complejos.",
		category: "Razonamiento",
		icon: "https://cdn.simpleicons.org/stmicroelectronics/03234B",
		tools: ["sequentialthinking"],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
	},
	{
		name: "everything",
		displayName: "Everything (Test)",
		description:
			"Servidor de prueba con todas las features MCP para desarrollo y testing.",
		category: "Dev",
		icon: "https://cdn.simpleicons.org/testinglibrary/ffffff",
		tools: ["echo", "sampleLLM", "longRunningOperation"],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-everything"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
	},
	{
		name: "google-maps",
		displayName: "Google Maps",
		description:
			"Geocodificación, direcciones y búsqueda de lugares con Google Maps.",
		category: "Geolocalización",
		icon: "🗺️",
		tools: [
			"maps_geocode",
			"maps_reverse_geocode",
			"maps_search_places",
			"maps_place_details",
			"maps_distance_matrix",
			"maps_elevation",
			"maps_directions",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-google-maps"],
			env: {
				GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}",
			},
		},
		requiresApiKey: "Google Maps API Key",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
	},
	{
		name: "slack",
		displayName: "Slack",
		description:
			"Envía mensajes, lee canales y gestiona tu workspace de Slack.",
		category: "Comunicación",
		icon: "💬",
		tools: [
			"slack_list_channels",
			"slack_post_message",
			"slack_get_channel_history",
			"slack_search_messages",
			"slack_get_thread_replies",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-slack"],
			env: {
				SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
				SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
			},
		},
		requiresApiKey: "Slack Bot Token + Team ID",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
	},
	{
		name: "gitlab",
		displayName: "GitLab",
		description: "Gestiona proyectos, merge requests y pipelines en GitLab.",
		category: "Dev",
		icon: "🦊",
		tools: [
			"create_or_update_file",
			"search_repositories",
			"create_repository",
			"get_file_contents",
			"create_issue",
			"create_merge_request",
			"search_code",
			"list_commits",
			"list_issues",
			"list_merge_requests",
			"get_merge_request",
			"create_merge_request_note",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-gitlab"],
			env: {
				GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_TOKEN}",
				GITLAB_API_URL: "https://gitlab.com/api/v4",
			},
		},
		requiresApiKey: "GitLab Personal Access Token",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
	},
	{
		name: "postgres",
		displayName: "PostgreSQL",
		description: "Ejecuta consultas SQL en bases de datos PostgreSQL.",
		category: "Datos",
		icon: "🐘",
		tools: ["query"],
		config: {
			command: "npx",
			args: [
				"-y",
				"@modelcontextprotocol/server-postgres",
				"postgresql://user:pass@localhost:5432/dbname",
			],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
	},
	{
		name: "sentinel",
		displayName: "Sentinel (Security)",
		description:
			"Análisis de seguridad: revisión de código, dependencias y vulnerabilidades.",
		category: "Seguridad",
		icon: "🛡️",
		tools: ["analyze_code", "scan_dependencies", "check_vulnerabilities"],
		config: {
			command: "npx",
			args: ["-y", "@anthropic-ai/mcp-server-sentinel"],
		},
		homepage: "https://github.com/anthropics/anthropic-quickstarts",
	},
	{
		name: "notion",
		displayName: "Notion",
		description:
			"Lee y gestiona páginas, bases de datos y contenido en Notion.",
		category: "Productividad",
		icon: "📝",
		tools: [
			"search_pages",
			"get_page",
			"create_page",
			"update_page",
			"search_databases",
			"query_database",
		],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-notion"],
			env: {
				OPENAPI_MCP_HEADERS:
					'{"Authorization":"Bearer ${NOTION_TOKEN}","Notion-Version":"2022-06-28"}',
			},
		},
		requiresApiKey: "Notion Integration Token",
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/notion",
	},
	{
		name: "time",
		displayName: "Time",
		description:
			"Obtiene la fecha y hora actuales, convierte entre zonas horarias.",
		category: "Utilidades",
		icon: "⏰",
		tools: ["get_current_time", "convert_time"],
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-time"],
		},
		homepage:
			"https://github.com/modelcontextprotocol/servers/tree/main/src/time",
	},
	{
		name: "gdrive",
		displayName: "Google Drive",
		description: "Busca, lee y gestiona archivos en Google Drive.",
		category: "Productividad",
		icon: "📁",
		tools: ["search_files", "read_file", "list_files"],
		config: {
			command: "npx",
			args: ["-y", "@anthropic-ai/mcp-server-gdrive"],
		},
		requiresApiKey: "Google OAuth credentials",
		homepage: "https://github.com/anthropics/anthropic-quickstarts",
	},
];
