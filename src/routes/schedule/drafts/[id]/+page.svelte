<script lang="ts">
	import ScheduleBoard from './ScheduleBoard.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<ScheduleBoard {data} {form} />
