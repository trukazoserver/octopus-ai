import { describe, it, expect } from 'vitest';
import { PermissionManager } from '../team/permissions.js';
import type { Role } from '../team/permissions.js';

describe('PermissionManager', () => {
  const pm = new PermissionManager();

  describe('admin role', () => {
    it('should have all permissions', () => {
      expect(pm.hasPermission('admin', 'chat')).toBe(true);
      expect(pm.hasPermission('admin', 'use_tools')).toBe(true);
      expect(pm.hasPermission('admin', 'manage_plugins')).toBe(true);
      expect(pm.hasPermission('admin', 'manage_users')).toBe(true);
      expect(pm.hasPermission('admin', 'delete_data')).toBe(true);
    });
  });

  describe('user role', () => {
    it('should allow chat and use_tools', () => {
      expect(pm.hasPermission('user', 'chat')).toBe(true);
      expect(pm.hasPermission('user', 'use_tools')).toBe(true);
    });

    it('should deny admin-level actions', () => {
      expect(pm.hasPermission('user', 'manage_plugins')).toBe(false);
      expect(pm.hasPermission('user', 'manage_users')).toBe(false);
      expect(pm.hasPermission('user', 'delete_data')).toBe(false);
    });
  });

  describe('guest role', () => {
    it('should only allow chat', () => {
      expect(pm.hasPermission('guest', 'chat')).toBe(true);
      expect(pm.hasPermission('guest', 'use_tools')).toBe(false);
      expect(pm.hasPermission('guest', 'manage_plugins')).toBe(false);
    });
  });
});
