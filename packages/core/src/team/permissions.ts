export type Role = "admin" | "user" | "guest";

export class PermissionManager {
  hasPermission(role: Role, action: string): boolean {
    if (role === "admin") {
      return true;
    }

    if (role === "user") {
      return action === "chat" || action === "use_tools";
    }

    if (role === "guest") {
      return action === "chat";
    }

    return false;
  }
}
