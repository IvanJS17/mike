"use client";

import { useQuickActionsPreference } from "@/app/components/assistant/quickActionsPreferences";
import { AccountSection } from "../AccountSection";
import { AccountToggle } from "../AccountToggle";

export default function FeaturesPage() {
    const { visibleActions, showAllQuickActions, hideAllQuickActions } =
        useQuickActionsPreference();
    const quickActionsEnabled = Object.values(visibleActions).some(Boolean);

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Assistant
                    </h2>
                </div>
                <AccountSection>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Quick actions
                            </p>
                            <p className="text-sm text-gray-500">
                                Show the quick actions row on the assistant
                                start screen.
                            </p>
                        </div>
                        <AccountToggle
                            checked={quickActionsEnabled}
                            size="md"
                            onChange={(checked) => {
                                if (checked) {
                                    showAllQuickActions();
                                } else {
                                    hideAllQuickActions();
                                }
                            }}
                        />
                    </div>
                </AccountSection>
            </section>
        </div>
    );
}
