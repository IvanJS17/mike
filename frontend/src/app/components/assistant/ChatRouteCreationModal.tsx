"use client";

import { useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import type { ModelRoute } from "@/app/lib/mikeApi";
import { GovernedModelRouteSelect } from "./GovernedModelRouteSelect";

interface Props {
    open: boolean;
    creating: boolean;
    onConfirm: (route: ModelRoute) => void;
    onCancel: () => void;
}

export function ChatRouteCreationModal({
    open,
    creating,
    onConfirm,
    onCancel,
}: Props) {
    const [route, setRoute] = useState<ModelRoute | null>(null);
    const cancelBeforeCreation = () => {
        if (!creating) onCancel();
    };

    return (
        <Modal
            open={open}
            onClose={cancelBeforeCreation}
            size="sm"
            className="h-auto min-h-[300px]"
            breadcrumbs={["Assistant", "New conversation"]}
            primaryAction={{
                label: creating ? "Starting…" : "Start conversation",
                onClick: () => route && onConfirm(route),
                disabled: creating || !route,
            }}
            cancelAction={{
                label: "Cancel",
                onClick: cancelBeforeCreation,
                disabled: creating,
            }}
        >
            <div className="space-y-5 py-4">
                <div>
                    <h2 className="font-serif text-2xl text-gray-950">
                        Choose this conversation&apos;s model route
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-gray-600">
                        The selected provider, model, and credential will pay
                        for and receive the authorized conversation context.
                        This route is fixed after the conversation starts.
                    </p>
                </div>
                <GovernedModelRouteSelect
                    value={route}
                    onChange={setRoute}
                    locked={false}
                    className="space-y-1"
                />
            </div>
        </Modal>
    );
}
