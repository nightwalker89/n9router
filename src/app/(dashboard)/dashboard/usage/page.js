"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import UsageStats from "@/shared/components/UsageStats";
import RequestDetailsTab from "./components/RequestDetailsTab";
import ApiKeyUsageReport from "./components/ApiKeyUsageReport";

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

const TOP_LEVEL_TABS = ["overview", "details", "logs", "report"];

function getValidTopLevelTab(tab) {
  return TOP_LEVEL_TABS.includes(tab) ? tab : "overview";
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const urlTab = getValidTopLevelTab(searchParams.get("tab"));
  const [selectedTab, setSelectedTab] = useState(urlTab);

  useEffect(() => {
    setSelectedTab(urlTab);
  }, [urlTab]);

  const handleTabChange = (value) => {
    if (value === selectedTab) return;
    setSelectedTab(value);
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <SegmentedControl
        options={[
          { value: "overview", label: "Overview" },
          { value: "details", label: "Details" },
          { value: "logs", label: "Logs" },
          { value: "report", label: "Reports" },
        ]}
        value={selectedTab}
        onChange={handleTabChange}
        className="w-full sm:w-auto"
      />

      {selectedTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats />
        </Suspense>
      )}
      {selectedTab === "details" && <RequestDetailsTab />}
      {selectedTab === "logs" && <RequestLogger />}
      {selectedTab === "report" && <ApiKeyUsageReport />}
    </div>
  );
}
