"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { supabase } from "@/app/lib/supabase";

const authInputClassName =
    "rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";

interface InvitePasswordSetupProps {
    onSuccess: () => void;
}

export function InvitePasswordSetup({ onSuccess }: InvitePasswordSetupProps) {
    const searchParams = useSearchParams();
    const tokenHash =
        searchParams.get("token_hash") ?? searchParams.get("token") ?? "";
    const inviteType = searchParams.get("type");
    const next = safeNextPath(searchParams.get("next"));

    const hasValidToken = !!tokenHash && (!inviteType || inviteType === "invite");
    const [isChecking, setIsChecking] = useState(() => hasValidToken);
    const [isSetting, setIsSetting] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(() =>
        !hasValidToken
            ? !tokenHash
                ? "Missing invitation token."
                : "Invalid invitation link."
            : null,
    );
    const [success, setSuccess] = useState(false);
    const verifyStartedRef = useRef(false);

    useEffect(() => {
        if (!hasValidToken || verifyStartedRef.current) return;
        verifyStartedRef.current = true;

        async function verifyInvite() {
            const { error: verifyError } = await supabase.auth.verifyOtp({
                token_hash: tokenHash,
                type: "invite",
            });
            if (verifyError) {
                setError(verifyError.message);
                setIsChecking(false);
                return;
            }

            const { data: sessionData } = await supabase.auth.getUser();
            if (sessionData.user?.email) setEmail(sessionData.user.email);
            setIsChecking(false);
        }

        void verifyInvite();
    }, [hasValidToken, tokenHash]);

    const canSetPassword =
        !isChecking &&
        !isSetting &&
        !!tokenHash &&
        password.length >= 6 &&
        password === confirmPassword;

    async function setInvitePassword(event: FormEvent) {
        event.preventDefault();

        if (!canSetPassword) return;

        setIsSetting(true);
        setError(null);
        const { error: updateError } = await supabase.auth.updateUser({
            password,
        });
        setIsSetting(false);

        if (updateError) {
            setError(updateError.message);
            return;
        }

        setSuccess(true);
        setTimeout(() => {
            onSuccess();
        }, 1500);
    }

    if (isChecking) {
        return (
            <div className="space-y-4">
                <div className="rounded-lg border border-gray-100 bg-gray-100/70 p-4 text-sm text-gray-600 text-center">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin inline" />
                    Verifying invite token...
                </div>
            </div>
        );
    }

    if (error) {
        return <div className="text-sm text-red-600">{error}</div>;
    }

    if (success) {
        return (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 text-center space-y-2">
                <p className="inline-flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-4 w-4" />
                    Invitation completed.
                </p>
                <p>Signing you in and opening your workspace...</p>
            </div>
        );
    }

    return (
        <form onSubmit={(event) => void setInvitePassword(event)} className="space-y-4">
            <div>
                <h2 className="text-2xl font-medium font-serif text-gray-950 mb-2">
                    Set your invitation password
                </h2>
                <p className="text-sm text-gray-600 mb-4">
                    {email ? `Invite accepted for ${email}.` : "Invite accepted."} Set
                    a password to access your account.
                </p>
            </div>

            <div>
                <label
                    htmlFor="invite-password"
                    className="block text-sm font-medium text-gray-700 mb-2"
                >
                    Password
                </label>
                <Input
                    id="invite-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Create a password (min. 6 characters)"
                    required
                    className={`w-full ${authInputClassName}`}
                />
            </div>

            <div>
                <label
                    htmlFor="invite-confirm-password"
                    className="block text-sm font-medium text-gray-700 mb-2"
                >
                    Confirm Password
                </label>
                <Input
                    id="invite-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Confirm your password"
                    required
                    className={`w-full ${authInputClassName}`}
                />
            </div>

            {error && (
                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                    {error}
                </p>
            )}

            <Button
                type="submit"
                disabled={!canSetPassword || isSetting}
                className="w-full bg-black hover:bg-gray-900 text-white"
            >
                {isSetting ? "Setting password..." : "Set password"}
            </Button>

            {next !== "/assistant" ? (
                <p className="text-xs text-gray-500 text-center">
                    You will be redirected to {next} when ready.
                </p>
            ) : null}
        </form>
    );
}

function safeNextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/assistant";
    }
    if (value.startsWith("/accept-invite")) return "/assistant";
    return value;
}
