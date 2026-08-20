import { base44 } from '@/api/base44Client';

// User-owned entities whose records are purged when a user deletes their account.
//
// The built-in User entity is intentionally EXCLUDED: deleting that row does not
// remove the authentication account (the Base44 SDK exposes no end-user
// self-service account-deletion API), so removing the User row would only
// orphan the auth identity while leaving it unable to sign in.
const USER_OWNED_ENTITIES = [
  'DriverProfile', 'CarrierProfile', 'Equipment', 'EquipmentAssignment',
  'DutyStatusEvent', 'EventVersion', 'Certification', 'DailySummary',
  'DVIR', 'Document', 'BillOfLading', 'FuelReceipt', 'Trip', 'TripStop',
  'AIProposal', 'AIUsageLog',
];

// Purge all app data owned by the signed-in user.
// Each deleteMany is scoped to created_by_id === userId so only the user's own
// records are ever touched. Returns a per-entity summary (best-effort: entities
// the user lacks permission to delete are reported as skipped).
export async function purgeMyData(userId) {
  const summary = {};
  for (const name of USER_OWNED_ENTITIES) {
    try {
      await base44.entities[name].deleteMany({ created_by_id: userId });
      summary[name] = 'deleted';
    } catch (e) {
      summary[name] = `skipped: ${e?.message || e}`;
    }
  }
  return summary;
}