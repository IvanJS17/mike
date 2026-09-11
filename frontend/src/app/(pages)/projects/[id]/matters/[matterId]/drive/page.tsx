"use client";

import { use } from "react";
import { MatterDriveSettings } from "@/app/components/recovery/drive/MatterDriveSettings";

interface Props {
  params: Promise<{ id: string; matterId: string }>;
}

export default function MatterDrivePage({ params }: Props) {
  const { id, matterId } = use(params);
  return (
    <MatterDriveSettings
      key={`${id}:${matterId}`}
      projectId={id}
      matterId={matterId}
    />
  );
}
