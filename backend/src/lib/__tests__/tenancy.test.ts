import { describe, it, expect, vi } from "vitest";
import {
  revokeOrganizationMembership,
  assertEpochFresh,
} from "../tenancy";

function makeDb() {
  const db = {
    from: vi.fn((table: string) => ({
      delete: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ data: null, error: null })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          eq: vi.fn(() => ({ data: null, error: null })),
        })),
      })),
    })),
    rpc: vi.fn(() => ({ data: null, error: null })),
  };
  return db as unknown as Parameters<typeof revokeOrganizationMembership>[0];
}

describe("revokeOrganizationMembership (W1.7)", () => {
  it("deletes the membership, increments the org epoch and signs the user out", async () => {
    const db = makeDb();
    const admin = {
      auth: {
        admin: {
          signOut: vi.fn(() => ({ data: {}, error: null })),
        },
      },
    };

    const result = await revokeOrganizationMembership(
      db,
      admin as never,
      "org-1",
      "user-9",
    );

    expect(result.ok).toBe(true);
    // membership deleted
    expect(db.from).toHaveBeenCalledWith("organization_memberships");
    // epoch incremented atomically via RPC
    expect(db.rpc).toHaveBeenCalledWith("bump_authorization_epoch", {
      p_org: "org-1",
    });
    // session revoked
    expect(admin.auth.admin.signOut).toHaveBeenCalledWith("user-9");
  });

  it("reports an error when the membership delete fails", async () => {
    const db = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ data: null, error: { message: "boom" } })),
          })),
        })),
      })),
    } as never;
    const admin = {
      auth: { admin: { signOut: vi.fn(() => ({ data: {}, error: null })) } },
    } as never;

    const result = await revokeOrganizationMembership(
      db,
      admin,
      "org-1",
      "user-9",
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("boom");
  });
});

describe("assertEpochFresh (W1.7)", () => {
  it("throws when the stored epoch is newer than the caller's snapshot", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => ({
              data: { authorization_epoch: 3 },
              error: null,
            })),
          })),
        })),
      })),
    } as never;

    await expect(
      assertEpochFresh(db, "org-1", 2),
    ).rejects.toThrow(/epoch/i);
  });

  it("resolves when the epoch matches the snapshot", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => ({
              data: { authorization_epoch: 2 },
              error: null,
            })),
          })),
        })),
      })),
    } as never;

    await expect(assertEpochFresh(db, "org-1", 2)).resolves.toBeUndefined();
  });
});
