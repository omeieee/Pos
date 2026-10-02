/** Read-side helpers over the entity store: pure functions of `EntityState`. */
import type { OptionDto } from '@sds/shared';
import type { EntityState, GroupEntity } from './entity-store.ts';

export interface GroupWithOptions extends GroupEntity {
  /** Archived and sold-out options are still here: callers filter with `availableOptions`. */
  options: OptionDto[];
}

/**
 * Modifier groups by id, each with its options joined by `groupId` and sorted for display. The
 * options come from the option rows themselves, never from a group frame's embedded copy.
 */
export function groupsWithOptions(
  state: Pick<EntityState, 'groups' | 'options'>,
): Map<string, GroupWithOptions> {
  const byGroup = new Map<string, OptionDto[]>();
  for (const option of state.options.values()) {
    const list = byGroup.get(option.groupId) ?? [];
    list.push(option);
    byGroup.set(option.groupId, list);
  }
  const bySort = (a: OptionDto, b: OptionDto) => a.sort - b.sort || a.id.localeCompare(b.id);
  const result = new Map<string, GroupWithOptions>();
  for (const group of state.groups.values()) {
    result.set(group.id, { ...group, options: (byGroup.get(group.id) ?? []).sort(bySort) });
  }
  return result;
}
