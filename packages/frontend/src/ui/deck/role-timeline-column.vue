<template>
<XColumn :menu="menu" :column="column" :is-stacked="isStacked" @parent-focus="$event => emit('parent-focus', $event)">
	<template #header>
		<i class="ti ti-badge"></i><span style="margin-left: 8px;">{{ column.name }}</span>
	</template>

	<MkTimeline v-if="column.roleId" ref="timeline" src="role" :role="column.roleId" @after="() => emit('loaded')"/>
</XColumn>
</template>

<script lang="ts" setup>
import { onMounted } from 'vue';
import XColumn from './column.vue';
import { updateColumn, Column } from './deck-store';
import MkTimeline from '@/components/MkTimeline.vue';
import * as os from '@/os';
import { i18n } from '@/i18n';

const props = defineProps<{
	column: Column;
	isStacked: boolean;
}>();

const emit = defineEmits<{
	(ev: 'loaded'): void;
	(ev: 'parent-focus', direction: 'up' | 'down' | 'left' | 'right'): void;
}>();

let timeline = $shallowRef<InstanceType<typeof MkTimeline>>();

onMounted(() => {
	if (props.column.roleId == null) {
		setRole();
	}
});

async function setRole() {
	const roles = await os.api('roles/list');
	const { canceled, result: role } = await os.select({
		title: i18n.ts.role,
		items: roles.map(x => ({
			value: x, text: x.name,
		})),
		default: props.column.roleId,
	});
	if (canceled) return;
	updateColumn(props.column.id, {
		roleId: role.id,
	});
}

const menu = [{
	icon: 'ti ti-pencil',
	text: i18n.ts.role,
	action: setRole,
}];

/*
function focus() {
	timeline.focus();
}

defineExpose({
	focus,
});
*/
</script>