export type RoomEndpoint = "state" | "join" | "action" | "socket";

export interface RoomRoute {
	code: string;
	endpoint: RoomEndpoint;
}

// Room Durable Objects are never public routes. The edge Worker accepts this
// API shape, validates the share code, then forwards to idFromName(code).
export function parseRoomRoute(pathname: string): RoomRoute | null {
	const match = pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(?:\/(state|join|action|socket))?$/i);
	if (!match) return null;
	return {
		code: match[1].toUpperCase(),
		endpoint: (match[2]?.toLowerCase() ?? "state") as RoomEndpoint,
	};
}
