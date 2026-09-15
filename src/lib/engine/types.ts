import type {
	DecorationType,
	FinishingStep,
	LineItemType,
	WeightClass
} from '../../../prisma/generated/prisma/enums';

export const ALL_SIBLINGS_DEPENDENCY = 'all_siblings' as const;

export interface EstimateHoursInput {
	itemType: LineItemType;
	decorationType?: DecorationType | null;
	finishingStep?: FinishingStep | null;
	inkColorCount?: number | null;
	screens?: number | null;
	stitchCount?: number | null;
	quantity: number;
	weightClass: WeightClass;
}

export interface EstimateStep {
	label: string;
	formula: string;
	minutes: number;
}

export interface EstimateHoursResult {
	station: string;
	hours: number;
	rawMinutes: number;
	steps: EstimateStep[];
}

export interface BacklogItem extends EstimateHoursInput {
	id: string;
	dueDate: Date;
}

export interface CapacitySlot {
	stationId: string;
	stationName: string;
	date: Date;
	availableHrs: number;
}

export interface ProposedAssignment {
	lineItemId: string;
	stationId: string;
	stationName: string;
	date: Date;
	sequenceOrder: number;
	estimatedHours: number;
}

export interface AtRiskFlag {
	lineItemId: string;
	requiredStation: string;
	dueDate: Date;
	reason: string;
}

export interface ProposeScheduleResult {
	assignments: ProposedAssignment[];
	atRisk: AtRiskFlag[];
	reasoning: string[];
}
