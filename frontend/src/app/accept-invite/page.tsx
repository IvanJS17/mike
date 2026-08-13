"use client";

import { useRouter } from "next/navigation";
import { SiteLogo } from "@/app/components/site-logo";
import { InvitePasswordSetup } from "@/app/components/auth/InvitePasswordSetup";

const authGlassCardClassName =
    "rounded-2xl border border-white/70 bg-white/72 p-8 shadow-[0_4px_14px_rgba(15,23,42,0.045),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-8px_18px_rgba(255,255,255,0.12)] backdrop-blur-2xl";

export default function AcceptInvitePage() {
    const router = useRouter();

    return (
        <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    <InvitePasswordSetup
                        onSuccess={() => router.replace("/assistant")}
                    />
                </div>
            </div>
        </div>
    );
}
