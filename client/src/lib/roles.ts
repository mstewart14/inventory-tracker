/** The three roles (FR-USR-36). The stored words are older than the names people see. */
export const ROLES = ["user", "admin", "outreach"] as const;

export const ROLE_NAMES: Record<string, string> = {
  admin: "Administrator",
  user: "Staff",
  outreach: "Outreach",
};

export const roleName = (role: string): string => ROLE_NAMES[role] ?? role;

/** What a standing join link may make (FR-USR-41): never an Administrator. */
export const JOIN_LINK_ROLES = ["user", "outreach"] as const;
