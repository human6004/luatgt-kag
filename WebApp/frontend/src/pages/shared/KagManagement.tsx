import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Button, Card, Field, Modal, Td, Th, inputCls } from "../../admin/ui";
import { Notice } from "./shared";
import { ApiError } from "../../api";
import {
  builderIssue,
  inspectionError,
  loadBuilderStatus,
  runBuilderAction,
  builderStateLabel,
  loadBuilderInputs,
  loadBuilderConfiguration,
  checkBuilderReadiness,
  loadBuilderProjects,
  builderNeo4jLink,
  previewBuilderSelection,
  loadBuilderPackages,
  packageReason,
  loadServing,
  changeServing,
  loadBuilderPackageExport,
  exportBuilderPackage,
  loadGraphProject,
  runGraphRetrieval,
  selectionVectorCount,
  startBuilderGraph,
  loadBuilderClear,
  clearBuilderData,
  loadGraphSources,
} from "./kag-inspection";
import type {
  BuilderStatus,
  BuilderConfiguration,
  BuilderSelection,
  SelectionRequest,
  BuilderProjects,
  BuilderPackages,
  BuilderPackageExport,
  ServingCatalog,
  ServingPreview,
  GraphRetrieval,
  BuilderClear,
  GraphProject,
} from "./kag-inspection";
import { servingReasons } from "./kag-inspection";

export function useInspection<T>(load: (signal?: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setValue(undefined);
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(inspectionError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, version]);
  return { value, setValue, error, loading, reload: () => setVersion((v) => v + 1) };
}

type LibraryRun = ServingCatalog["runs"][number];
type LibraryRead = "projects" | "serving" | "configuration" | "status" | "export" | "clear";
const libraryReadLabels: Record<LibraryRead, string> = {
  projects: "Danh sách project",
  serving: "Thư viện đồ thị",
  configuration: "Cấu hình dựng",
  status: "Trạng thái dựng",
  export: "Trạng thái xuất gói",
  clear: "Trạng thái xóa",
};
function libraryReadIssue(part: LibraryRead, failure: unknown) {
  return (part === "projects" || part === "serving") &&
    failure instanceof ApiError &&
    [403, 409].includes(failure.status)
    ? "Đăng nhập lại OpenSPG rồi tải lại danh sách."
    : inspectionError(failure);
}

export function GraphLibrary({ searchOptions }: { searchOptions: ReactNode }) {
  const [parameters, setParameters] = useSearchParams();
  const [catalog, setCatalog] = useState<BuilderProjects>();
  const [projectData, setProjectData] = useState<
    Record<number, "EMPTY" | "OCCUPIED" | "UNAVAILABLE">
  >({});
  const [serving, setServing] = useState<ServingCatalog>();
  const [config, setConfig] = useState<BuilderConfiguration>();
  const [status, setStatus] = useState<BuilderStatus>();
  const [packages, setPackages] = useState<BuilderPackages>();
  const [exportState, setExportState] = useState<BuilderPackageExport>();
  const [clearState, setClearState] = useState<BuilderClear>(),
    [clearConfirmation, setClearConfirmation] = useState<GraphProject>();
  const [error, setError] = useState(""),
    [detailError, setDetailError] = useState("");
  const [readErrors, setReadErrors] = useState<Partial<Record<LibraryRead, string>>>({});
  const [libraryLoading, setLibraryLoading] = useState(true);
  const libraryError = readErrors.projects || readErrors.serving;
  const readError =
    libraryError || readErrors.configuration || readErrors.status || readErrors.clear;
  const [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  const [mode, setMode] = useState<"build" | "import" | null>(null);
  const [projectId, setProjectId] = useState(""),
    [scope, setScope] = useState("ALL"),
    [percent, setPercent] = useState("10");
  const [packageName, setPackageName] = useState(""),
    [selection, setSelection] = useState<BuilderSelection>();
  const [planSha256, setPlanSha256] = useState(""),
    [sourceLoading, setSourceLoading] = useState(false);
  const [sourcePreparing, setSourcePreparing] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [progress, setProgress] = useState(""),
    [preview, setPreview] = useState<ServingPreview>();
  const [view, setView] = useState<LibraryRun>();
  const acting = useRef(false),
    choosing = useRef(0);
  const selectedPackage = packages?.packages.find((row) => row.name === packageName);
  const selectedProjectReady =
    !!projectId &&
    projectData[Number(projectId)] === "EMPTY" &&
    !!catalog?.projects.some(
      (row) => row.project_id === Number(projectId) && row.state === "AVAILABLE",
    );
  const requestedScope: SelectionRequest =
    mode === "import"
      ? selectedPackage?.manifest?.selection === null
        ? { mode: "ALL", value: null }
        : { mode: "COUNT", value: Number(selectedPackage?.manifest?.selection?.value) }
      : scope === "ALL"
        ? { mode: "ALL", value: null }
        : { mode: "PERCENT", value: Number(percent) };
  const requestKey = JSON.stringify(requestedScope);
  const recoveringWrite = status?.error_code === "UNCERTAIN_WRITE" && status.actions.resume;
  const building =
    status && (["RUNNING", "STOPPING", "STOPPED"].includes(status.state) || recoveringWrite);
  const running = status && ["RUNNING", "STOPPING"].includes(status.state);
  const clearing = clearState && ["APPLYING", "PARTIAL", "INTERRUPTED"].includes(clearState.state);
  function acceptProjects(projects: BuilderProjects) {
    if (!["AVAILABLE", "EMPTY"].includes(projects.state))
      throw new ApiError(
        "Chưa đọc được danh sách project",
        projects.state === "FORBIDDEN" ? 403 : 503,
      );
    setCatalog(projects);
  }
  useEffect(() => {
    setWaitSeconds(0);
    if (!mode || (!sourcePreparing && !sourceLoading)) return;
    const started = Date.now(),
      timer = setInterval(() => setWaitSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [mode, sourcePreparing, sourceLoading]);
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    const timers: Partial<Record<LibraryRead, ReturnType<typeof setTimeout>>> = {};
    async function read<T>(part: LibraryRead, load: () => Promise<T>, save: (value: T) => void) {
      if (part === "serving") setLibraryLoading(true);
      try {
        const value = await load();
        if (controller.signal.aborted) return;
        save(value);
        setReadErrors((current) => ({ ...current, [part]: "" }));
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [403, 409].includes(failure.status)) {
          if (part === "projects") setCatalog(undefined);
          if (part === "serving") setServing(undefined);
        }
        setReadErrors((current) => ({ ...current, [part]: libraryReadIssue(part, failure) }));
      } finally {
        if (!controller.signal.aborted) {
          if (part === "serving") setLibraryLoading(false);
          timers[part] = setTimeout(() => void read(part, load, save), 3000);
        }
      }
    }
    if (!mode) void read("projects", () => loadBuilderProjects(controller.signal), acceptProjects);
    void read("serving", () => loadServing(controller.signal), setServing);
    void read("configuration", () => loadBuilderConfiguration(controller.signal), setConfig);
    void read("status", () => loadBuilderStatus(controller.signal), setStatus);
    void read("export", () => loadBuilderPackageExport(controller.signal), setExportState);
    void read("clear", () => loadBuilderClear(controller.signal), setClearState);
    return () => {
      controller.abort();
      Object.values(timers).forEach(clearTimeout);
    };
  }, [busy, version, mode]);
  useEffect(() => {
    if (!mode) return;
    const controller = new AbortController();
    setProjectData({});
    // Refresh counts only on open or explicit reload, after reading the latest catalog.
    loadBuilderProjects(controller.signal)
      .then((projects) => {
        if (controller.signal.aborted) return;
        acceptProjects(projects);
        setReadErrors((current) => ({ ...current, projects: "" }));
        for (const row of projects.projects.filter((row) => row.state === "AVAILABLE")) {
          loadGraphProject(row.project_id, controller.signal)
            .then((graph) => {
              if (!controller.signal.aborted)
                setProjectData((current) => ({
                  ...current,
                  [row.project_id]: graph.counts.nodes || graph.counts.edges ? "OCCUPIED" : "EMPTY",
                }));
            })
            .catch(() => {
              if (!controller.signal.aborted)
                setProjectData((current) => ({ ...current, [row.project_id]: "UNAVAILABLE" }));
            });
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(libraryReadIssue("projects", failure));
          setDetailError(inspectionError(failure));
        }
      });
    return () => controller.abort();
  }, [mode, version]);
  useEffect(() => {
    if (!mode) return;
    const controller = new AbortController();
    setSourcePreparing(true);
    setPlanSha256("");
    setSelection(undefined);
    async function prepareSource() {
      try {
        let inputs = await loadBuilderInputs(controller.signal);
        if (controller.signal.aborted) return;
        if (inputs.source_validation.state === "NOT_RUN")
          inputs = await loadBuilderInputs(controller.signal, true);
        while (inputs.source_validation.state === "CHECKING") {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (controller.signal.aborted) return;
          inputs = await loadBuilderInputs(controller.signal);
        }
        if (inputs.source_validation.state !== "VALID") {
          setError(builderIssue(inputs.source_validation.error_code ?? "PLAN"));
          setDetailError(inputs.source_validation.error_code ?? "");
          return;
        }
        if (!controller.signal.aborted) setPlanSha256(inputs.source_validation.plan_sha256!);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError("Chưa đọc được dữ liệu nguồn. Kiểm tra dữ liệu rồi tải lại.");
          setDetailError(inspectionError(failure));
        }
      } finally {
        if (!controller.signal.aborted) setSourcePreparing(false);
      }
    }
    void prepareSource();
    return () => controller.abort();
  }, [mode, version]);
  useEffect(() => {
    if (!mode || !planSha256) return;
    const controller = new AbortController();
    loadBuilderPackages(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPackages(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError("Không đọc được danh sách gói. Tải lại sau khi chuẩn bị dữ liệu nguồn.");
          setDetailError(inspectionError(failure));
        }
      });
    return () => controller.abort();
  }, [mode, planSha256, version]);
  useEffect(() => {
    const id = ++choosing.current;
    setSelection(undefined);
    setSourceLoading(false);
    if (!mode || !config || !planSha256 || (mode === "import" && !selectedPackage?.compatible))
      return;
    if (
      requestedScope.mode !== "ALL" &&
      (!Number.isInteger(requestedScope.value) ||
        requestedScope.value! < 1 ||
        requestedScope.value! > (requestedScope.mode === "PERCENT" ? 100 : 2147483647))
    )
      return;
    setSourceLoading(true);
    const controller = new AbortController();
    const delay = setTimeout(() => void readSelection(), 250);
    async function readSelection() {
      try {
        const value = await previewBuilderSelection(
          config!.revision,
          requestedScope,
          controller.signal,
        );
        if (id === choosing.current) setSelection(value);
      } catch (failure) {
        if (id === choosing.current) {
          const detail = inspectionError(failure);
          setError(
            detail === "Phiên dựng trước chưa kết thúc"
              ? detail
              : "Chưa đọc được phạm vi dữ liệu. Kiểm tra dữ liệu nguồn rồi tải lại.",
          );
          setDetailError(detail);
        }
      } finally {
        if (id === choosing.current) setSourceLoading(false);
      }
    }
    return () => {
      choosing.current++;
      controller.abort();
      clearTimeout(delay);
    };
  }, [mode, config?.revision, planSha256, requestKey, selectedPackage?.sha256, version]);
  const refresh = () => setVersion((value) => value + 1);
  async function act(operation: () => Promise<unknown>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    setDetailError("");
    try {
      await operation();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Thao tác chưa hoàn tất. Tải lại trạng thái trước khi thử tiếp.",
      );
      setDetailError(inspectionError(failure));
    } finally {
      acting.current = false;
      setBusy(false);
      refresh();
    }
  }
  function openFlow(next: "build" | "import") {
    setMode(next);
    setProgress("");
    setProjectId("");
    setPackageName("");
    setScope("ALL");
    setSelection(undefined);
    setPlanSha256("");
    setError("");
    setDetailError("");
  }
  async function begin() {
    if (
      !mode ||
      !selection ||
      !selectedProjectReady ||
      sourceLoading ||
      sourcePreparing ||
      (mode === "import" && (!selectedPackage?.compatible || !selectedPackage.sha256))
    )
      return;
    const vectorPackage =
      mode === "import"
        ? { name: selectedPackage!.name, sha256: selectedPackage!.sha256! }
        : undefined;
    await act(async () => {
      setStatus(
        await startBuilderGraph(
          { projectId: Number(projectId), selection, vectorPackage },
          setProgress,
        ),
      );
      setMode(null);
      setProgress("");
    });
  }
  async function resume() {
    if (!status?.run_id || !config || !status.actions.resume) return;
    if (
      recoveringWrite &&
      !window.confirm(
        "Lần ghi trước bị gián đoạn. Phần mềm sẽ đọc lại đợt ghi dở và chỉ ghi lại nếu toàn bộ đợt chưa có trong database. Nếu đã ghi một phần hoặc dữ liệu khác với dự kiến, phần mềm sẽ dừng. Tiếp tục?",
      )
    )
      return;
    await act(async () => {
      let checked = await checkBuilderReadiness();
      while (checked.readiness.state === "CHECKING") {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        checked = await loadBuilderConfiguration();
      }
      if (checked.readiness.state !== "READY") {
        const issue = checked.readiness.checks.find((row) => row.state === "BLOCKED");
        throw new Error(builderIssue(issue?.code ?? "CONFIG"));
      }
      if (
        checked.target?.project_id !== status.target?.project_id ||
        checked.revision !== config.revision
      )
        throw new Error("Cấu hình đã đổi");
      setStatus(await runBuilderAction("resume", status.run_id!, checked.revision));
    });
  }
  const clearReport = catalog?.projects.some(
    (row) => row.project_id === clearState?.report?.target.project_id,
  )
    ? clearState?.report
    : null;
  const rows = (serving?.runs ?? []).filter(
    (row, index, all) => all.findIndex((other) => other.database === row.database) === index,
  );
  async function showClear(projectId: number) {
    await act(async () => {
      setClearConfirmation(await loadGraphProject(projectId));
    });
  }
  async function confirmClear() {
    if (!clearConfirmation) return;
    await act(async () => {
      setClearState(
        await clearBuilderData(clearConfirmation.target.project_id, clearConfirmation.database_id),
      );
      setClearConfirmation(undefined);
    });
  }
  useEffect(() => {
    const requested = parameters.get("project_id");
    if (requested && !view) {
      const row = serving?.runs.find(
        (row) =>
          String(row.project_id) === requested &&
          (!parameters.get("run_id") || row.run_id === parameters.get("run_id")),
      );
      if (row) setView(row);
    }
  }, [parameters, serving]);
  function closeView() {
    setView(undefined);
    const next = new URLSearchParams(parameters);
    ["project_id", "run_id", "verify_run", "bstep"].forEach((key) => next.delete(key));
    setParameters(next, { replace: true });
  }
  return (
    <section id="graph-library" className="space-y-5 mt-6" aria-label="Đồ thị">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Đồ thị</h2>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            disabled={
              busy ||
              serving?.busy ||
              !!running ||
              !!clearing ||
              !!readError ||
              !config ||
              recoveringWrite
            }
            onClick={() => openFlow("build")}
          >
            + Dựng đồ thị mới
          </Button>
          <Button
            disabled={
              busy ||
              serving?.busy ||
              !!running ||
              !!clearing ||
              !!readError ||
              !config ||
              recoveringWrite
            }
            onClick={() => openFlow("import")}
          >
            + Nhập từ gói
          </Button>
          <Button disabled={busy} onClick={refresh}>
            Tải lại danh sách
          </Button>
        </div>
      </div>
      <Card
        title={
          serving?.active
            ? `Đang dùng cho Chat: ${serving.active.project_name}`
            : !serving
              ? libraryError
                ? "Chưa đọc được đồ thị"
                : "Đang đọc đồ thị…"
              : "Chưa chọn đồ thị"
        }
        right={
          <Button onClick={() => document.getElementById("graph-table")?.focus()}>
            Chọn đồ thị
          </Button>
        }
      >
        <div className="px-5 pb-5 text-sm space-y-3">
          <p>
            {serving?.active && serving.runtime_ready && !serving.chat_blockers.length
              ? "Chat đang dùng đồ thị này để tìm căn cứ trả lời."
              : "Chọn đồ thị sẵn sàng để Chat tìm căn cứ trả lời."}
          </p>
          {serving?.chat_blockers
            .filter((code) => code !== "GRAPH_REQUIRED")
            .map((code) => (
              <p key={code}>
                {servingReasons[code] ?? "Đồ thị chưa sẵn sàng. Mở Xem để kiểm tra."}
              </p>
            ))}
          <details>
            <summary className="underline cursor-pointer">Tùy chọn tìm kiếm</summary>
            <div className="mt-4">{searchOptions}</div>
          </details>
        </div>
      </Card>
      {(error || Object.values(readErrors).some(Boolean)) && (
        <div role="alert" className="text-sm space-y-2">
          {error && <p>{error}</p>}
          {Object.entries(readErrors)
            .filter(([, message]) => message)
            .map(([part, message]) => (
              <p key={part}>
                {libraryReadLabels[part as LibraryRead]}: {message}
              </p>
            ))}
          {libraryError && config?.links?.openspg && (
            <a className="underline" target="_blank" rel="noreferrer" href={config.links.openspg}>
              Mở OpenSPG
            </a>
          )}
          {detailError && (
            <details>
              <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
              <pre className="whitespace-pre-wrap break-all">{detailError}</pre>
            </details>
          )}
        </div>
      )}
      {serving?.operation?.state === "PREPARING" && (
        <p role="status">Đang chuẩn bị đồ thị cho Chat…</p>
      )}
      {serving?.operation && ["FAILED", "INTERRUPTED"].includes(serving.operation.state) && (
        <div role="alert">
          <p>Chưa dùng được đồ thị cho Chat. Tải lại trạng thái trước khi thử tiếp.</p>
          <details>
            <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
            <pre>{serving.operation.code}</pre>
          </details>
        </div>
      )}
      <div
        id="graph-table"
        tabIndex={-1}
        className="overflow-x-auto rounded-2xl border border-line bg-surface"
      >
        <table className="w-full text-sm" aria-label="Thư viện đồ thị">
          <thead>
            <tr>
              {["Tên", "Phạm vi", "Nội dung", "Liên kết", "Vector", "Trạng thái", "Thao tác"].map(
                (label) => (
                  <Th key={label}>{label}</Th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {status && (building || status.state === "BLOCKED") && (
              <tr>
                <Td>
                  {catalog?.projects.find((row) => row.project_id === status.target?.project_id)
                    ?.project_name ?? "Đồ thị đang dựng"}
                </Td>
                <Td>
                  {status.contract_version !== "builder-control-v1" && status.binding?.node_limit
                    ? "Một phần"
                    : "Toàn bộ"}
                </Td>
                <td colSpan={3} className="px-5 py-3">
                  {status.progress && (
                    <p>
                      {status.progress.done.toLocaleString("vi-VN")}/
                      {status.progress.total.toLocaleString("vi-VN")}
                    </p>
                  )}
                </td>
                <Td>{builderStateLabel(status.state)}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || !status.actions.stop}
                      onClick={() =>
                        void act(async () =>
                          setStatus(await runBuilderAction("stop", status.run_id!)),
                        )
                      }
                    >
                      Dừng
                    </Button>
                    <Button
                      disabled={busy || !!readError || !status.actions.resume}
                      onClick={() => void resume()}
                    >
                      Tiếp tục
                    </Button>
                    {status.target && (
                      <Button
                        disabled={busy || !!readError || !!clearing}
                        onClick={() => void showClear(status.target!.project_id)}
                      >
                        Xóa
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.project_id}:${row.run_id}`} className="border-t border-line">
                <Td>{row.project_name}</Td>
                <Td>{row.partial ? "Một phần" : "Toàn bộ"}</Td>
                <Td>{row.nodes.toLocaleString("vi-VN")}</Td>
                <Td>{row.edges.toLocaleString("vi-VN")}</Td>
                <Td>{row.vectors.toLocaleString("vi-VN")}</Td>
                <Td>
                  {serving?.active?.database === row.database ? "Đang dùng cho Chat" : "Đã dựng"}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        !!libraryError ||
                        serving?.busy ||
                        serving?.active?.database === row.database ||
                        (!!clearing && clearReport?.target.database === row.database)
                      }
                      onClick={() =>
                        void act(async () =>
                          setPreview(await changeServing("preview", row.project_id, row.run_id)),
                        )
                      }
                    >
                      Dùng cho Chat
                    </Button>
                    <Button
                      disabled={
                        busy || !!libraryError || serving?.busy || exportState?.state === "RUNNING"
                      }
                      onClick={() =>
                        void act(async () =>
                          setExportState(await exportBuilderPackage(row.project_id, row.run_id)),
                        )
                      }
                    >
                      Xuất gói
                    </Button>
                    <Button disabled={busy} onClick={() => setView(row)}>
                      Xem
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        !!libraryError ||
                        serving?.busy ||
                        (!!clearing && clearReport?.target.database !== row.database) ||
                        clearState?.state === "APPLYING"
                      }
                      title={
                        clearing && clearReport?.target.database !== row.database
                          ? "Hoàn tất xóa đồ thị trước"
                          : undefined
                      }
                      onClick={() => void showClear(row.project_id)}
                    >
                      Xóa
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
            {clearing &&
              clearReport &&
              !rows.some((row) => row.database === clearReport.target.database) && (
                <tr className="border-t border-line">
                  <Td>{clearReport.target.project_name}</Td>
                  <Td>Đang xóa dữ liệu</Td>
                  <Td>{clearReport.counts.nodes.toLocaleString("vi-VN")}</Td>
                  <Td>{clearReport.counts.edges.toLocaleString("vi-VN")}</Td>
                  <Td>—</Td>
                  <Td>{clearState?.state === "APPLYING" ? "Đang xóa" : "Chưa xóa xong"}</Td>
                  <Td>
                    <Button
                      disabled={busy || !!readError || clearState?.state === "APPLYING"}
                      onClick={() => void showClear(clearReport.target.project_id)}
                    >
                      Xóa tiếp
                    </Button>
                  </Td>
                </tr>
              )}
            {!rows.length && !building && status?.state !== "BLOCKED" && (
              <tr>
                <td colSpan={7} className="px-5 py-3">
                  {libraryError ||
                    (!serving && libraryLoading
                      ? "Đang đọc danh sách đồ thị…"
                      : "Chưa có đồ thị đã dựng. Dựng mới hoặc nhập từ gói để bắt đầu.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {status && (building || status.state === "BLOCKED") && (
        <div className="text-sm space-y-2">
          {status.contract_version !== "builder-control-v1" &&
            status.stages.map((stage) => (
              <p key={stage.name}>
                {
                  (
                    {
                      preflight: "Kiểm tra điều kiện",
                      plan: "Chuẩn bị dữ liệu",
                      vectorize: "Tạo vector",
                      "export-artifact": "Lưu vector",
                      "write-nodes": "Ghi nội dung",
                      "verify-nodes": "Kiểm nội dung",
                      "write-edges": "Ghi liên kết",
                      verify: "Xác minh đồ thị",
                      release: "Lưu kết quả",
                    } as Record<string, string>
                  )[stage.name]
                }
                :{" "}
                {
                  {
                    PENDING: "Chưa thực hiện",
                    RUNNING: "Đang xử lý",
                    COMPLETE: "Hoàn tất",
                    STOPPED: "Đã dừng",
                    BLOCKED: "Cần xử lý",
                  }[stage.state]
                }{" "}
                {stage.done !== null ? `${stage.done}/${stage.total}` : ""}
              </p>
            ))}
          {status.error_code && <p role="alert">{builderIssue(status.error_code)}</p>}
          <details>
            <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(status, null, 2)}</pre>
          </details>
        </div>
      )}
      {exportState?.state === "RUNNING" && <p role="status">Đang xuất gói…</p>}
      {exportState?.state === "COMPLETE" && (
        <p role="status" className="text-sm break-words">
          Đã xuất {exportState.name}. Lấy tệp tại {exportState.directory} để chép sang máy khác.
        </p>
      )}
      {exportState?.state === "FAILED" && (
        <p role="alert">Xuất gói chưa hoàn tất. {packageReason(exportState.code ?? "")}</p>
      )}
      {clearReport &&
        clearState &&
        clearState.state !== "NOT_RUN" &&
        (clearState.state !== "COMPLETE" ||
          !rows.some((row) => row.database === clearReport.target.database)) && (
          <div className="text-sm space-y-2" role="status">
            <p>
              {clearState.state === "COMPLETE" &&
              clearReport.counts.nodes === 0 &&
              clearReport.counts.edges === 0
                ? "Đã xóa đồ thị. Có thể tái sử dụng đích trống trong OpenSPG."
                : `Đã xóa ${clearState.deleted.nodes.toLocaleString("vi-VN")} nội dung và ${clearState.deleted.edges.toLocaleString("vi-VN")} liên kết; ${clearState.state === "APPLYING" ? "đang tiếp tục." : "chưa hoàn tất, tải lại để kiểm tra."}`}
            </p>
            {clearState.code && (
              <p>
                {["SCOPE", "CLEAR_SERVING"].includes(clearState.code)
                  ? "Đồ thị vừa được dùng lại cho Chat. Tải lại rồi xác nhận xóa lại."
                  : builderIssue(clearState.code)}
              </p>
            )}
            <details>
              <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(clearState, null, 2)}
              </pre>
            </details>
          </div>
        )}
      <Modal
        open={mode !== null}
        title={mode === "import" ? "Nhập từ gói" : "Dựng đồ thị mới"}
        onClose={() => {
          if (!busy) setMode(null);
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setMode(null)}>
              Hủy
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                !selectedProjectReady ||
                !selection ||
                sourceLoading ||
                sourcePreparing ||
                !!building ||
                (mode === "import" && !selectedPackage?.compatible)
              }
              onClick={() => void begin()}
            >
              {mode === "import" ? "Xác nhận nhập" : "Xác nhận dựng"}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="space-y-3">
            <p>Tạo project trong OpenSPG, rồi tải lại danh sách và chọn đồ thị trống.</p>
            <div className="flex gap-3">
              {config?.links?.openspg && (
                <a
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                  href={config.links.openspg}
                >
                  Mở OpenSPG
                </a>
              )}
              <Button disabled={busy} onClick={refresh}>
                Tải lại danh sách
              </Button>
            </div>
            <Field label="Đồ thị trống">
              <select
                className={inputCls}
                value={projectId}
                disabled={busy}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="" disabled>
                  Chọn đồ thị trống trong OpenSPG
                </option>
                {catalog?.projects
                  .filter((row) => row.state === "AVAILABLE")
                  .map((row) => (
                    <option
                      key={row.project_id}
                      value={row.project_id}
                      disabled={projectData[row.project_id] !== "EMPTY"}
                    >
                      {row.project_name}
                      {projectData[row.project_id] === "OCCUPIED"
                        ? " — Đã có dữ liệu"
                        : projectData[row.project_id] === "UNAVAILABLE"
                          ? " — Chưa đọc được dữ liệu"
                          : !projectData[row.project_id]
                            ? " — Đang đọc dữ liệu"
                            : ""}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {mode === "import" ? (
            <>
              <p>Chép ZIP vào thư mục {packages?.directory ?? "graph-packages"} rồi tải lại.</p>
              <Field label="Gói đồ thị">
                <select
                  className={inputCls}
                  value={packageName}
                  disabled={busy}
                  onChange={(event) => setPackageName(event.target.value)}
                >
                  <option value="">Chọn gói</option>
                  {packages?.packages.map((row) => (
                    <option key={row.name} value={row.name} disabled={!row.compatible}>
                      {row.compatible ? "✓" : "✗"} {row.name}
                    </option>
                  ))}
                </select>
              </Field>
              {packages?.packages
                .filter((row) => !row.compatible)
                .map((row) => (
                  <p key={row.name}>
                    {row.name}: {packageReason(row.reason)}
                  </p>
                ))}
              {selectedPackage?.manifest && (
                <p>
                  Phạm vi từ gói:{" "}
                  {selectedPackage.manifest.selection === null ? "toàn bộ" : "một phần"} ·{" "}
                  {selectedPackage.manifest.nodes.toLocaleString("vi-VN")} nội dung. Nhập vào đồ thị
                  trống đã có không gọi embedding.
                </p>
              )}
            </>
          ) : (
            <>
              <Field label="Phạm vi">
                <select
                  className={inputCls}
                  value={scope}
                  disabled={busy}
                  onChange={(event) => setScope(event.target.value)}
                >
                  <option value="ALL">Toàn bộ dữ liệu</option>
                  <option value="PERCENT">Một phần dữ liệu</option>
                </select>
              </Field>
              {scope === "PERCENT" && (
                <Field label="Tỷ lệ dữ liệu (%)">
                  <input
                    className={inputCls}
                    type="number"
                    min={1}
                    max={100}
                    value={percent}
                    disabled={busy}
                    onChange={(event) => setPercent(event.target.value)}
                  />
                </Field>
              )}
              {scope === "PERCENT" && <p>Bản thử {percent}%</p>}
            </>
          )}
          {sourcePreparing ? (
            <p role="status">Đang chuẩn bị dữ liệu nguồn · {waitSeconds} giây</p>
          ) : sourceLoading ? (
            <p role="status">Đang tính phạm vi · {waitSeconds} giây</p>
          ) : (
            selection && (
              <p>
                {selection.summary.nodes.toLocaleString("vi-VN")} nội dung ·{" "}
                {selection.summary.edges.toLocaleString("vi-VN")} liên kết.
                {mode === "build" &&
                  ` Cần tạo khoảng ${selectionVectorCount(selection.summary).toLocaleString("vi-VN")} vector.`}
              </p>
            )
          )}
          {mode === "build" && (
            <p>Tạo vector có thể phát sinh phí embedding. Dựng xong chưa tự dùng cho Chat.</p>
          )}
          {!selection && !sourceLoading && !sourcePreparing && (
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  let value = await loadBuilderInputs(undefined, true);
                  while (value.source_validation.state === "CHECKING") {
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    value = await loadBuilderInputs();
                  }
                  if (value.source_validation.state !== "VALID")
                    throw new Error("Nguồn chưa sẵn sàng");
                })
              }
            >
              Tải lại dữ liệu
            </Button>
          )}
          {progress && <p role="status">{progress}</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              {detailError && (
                <details>
                  <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
                  <p>{detailError}</p>
                </details>
              )}
            </div>
          )}
        </div>
      </Modal>
      {preview && (
        <Modal
          open
          title="Dùng đồ thị cho Chat"
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setPreview(undefined)}>
                Hủy
              </Button>
              <Button
                variant="primary"
                disabled={busy || !!readError || !preview.chat_ready}
                onClick={() =>
                  void act(async () => {
                    const result = await changeServing(
                      "activate",
                      preview.project_id,
                      preview.run_id,
                      preview.preview_id,
                    );
                    if ("contract_version" in result)
                      setServing((value) =>
                        value ? { ...value, busy: true, operation: result } : value,
                      );
                    setPreview(undefined);
                  })
                }
              >
                Xác nhận dùng cho Chat
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              Chuyển từ {preview.previous?.project_name ?? "chưa chọn"} sang {preview.project_name}.
            </p>
            <p>
              {preview.counts.nodes.toLocaleString("vi-VN")} nội dung ·{" "}
              {preview.counts.edges.toLocaleString("vi-VN")} liên kết.
            </p>
            {preview.preparation_required && (
              <p>Cần chuẩn bị lần đầu. Đồ thị sẽ được xác minh ở nền sau khi xác nhận.</p>
            )}
            {preview.chat_blockers.map((code) => (
              <p key={code}>
                {servingReasons[code] ?? "Chưa thể dùng đồ thị. Kiểm tra model và dữ liệu."}
              </p>
            ))}
            <details>
              <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(preview, null, 2)}
              </pre>
            </details>
            {(error || readError) && <p role="alert">{readError || error}</p>}
          </div>
        </Modal>
      )}
      {view && (
        <Modal open title={view.project_name} onClose={closeView}>
          <div className="space-y-5">
            <SelectedGraph projectId={view.project_id} links={config?.links} />
            <GraphSourceList key={view.run_id} projectId={view.project_id} runId={view.run_id} />
            <details>
              <summary className="underline cursor-pointer">Thử tìm kiếm</summary>
              <div className="mt-4">
                <TrialGraph
                  projectId={view.project_id}
                  runId={view.run_id}
                  modelPath="/admin/chatbot?step=1"
                  builtModel={view.model_identity}
                  dimension={view.dimension}
                />
              </div>
            </details>
            <details>
              <summary className="underline cursor-pointer">Chi tiết kỹ thuật phiên</summary>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(
                  {
                    selected: view,
                    runs: serving?.runs.filter((row) => row.database === view.database),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        </Modal>
      )}
      {clearConfirmation && (
        <Modal
          open
          title="Xóa đồ thị"
          onClose={() => {
            if (!busy) setClearConfirmation(undefined);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setClearConfirmation(undefined)}>
                Hủy
              </Button>
              <Button
                variant="primary"
                disabled={busy || !!readError}
                onClick={() => void confirmClear()}
              >
                Xác nhận xóa
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              Xóa đồ thị {clearConfirmation.target.project_name}, gồm{" "}
              {clearConfirmation.counts.nodes.toLocaleString("vi-VN")} nội dung. Không thể hoàn tác.
            </p>
            {serving?.active &&
              (serving.active.database_id === clearConfirmation.database_id ||
                serving.active.database === clearConfirmation.target.database) && (
                <p>Chat tạm ngưng trả lời cho tới khi chọn đồ thị khác</p>
              )}
            {(error || readError) && <p role="alert">{readError || error}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}

function GraphSourceList({ projectId, runId }: { projectId: number; runId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="underline cursor-pointer">Nguồn của lần dựng</summary>
      {open && <GraphSourcePage projectId={projectId} runId={runId} />}
    </details>
  );
}

function GraphSourcePage({ projectId, runId }: { projectId: number; runId: string }) {
  const load = useCallback(
    (signal?: AbortSignal) => loadGraphSources(projectId, runId, signal),
    [projectId, runId],
  );
  const data = useInspection(load),
    [page, setPage] = useState(0);
  const rows = [...(data.value?.documents ?? []), ...(data.value?.units ?? [])];
  return (
    <div className="mt-4 space-y-3 text-sm">
      <Notice {...data} retry={data.reload} />
      {data.value && (
        <>
          <p>
            Nguồn lưu theo lần dựng: {data.value.documents.length.toLocaleString("vi-VN")} văn bản,{" "}
            {data.value.units.length.toLocaleString("vi-VN")} nội dung. Số liệu đồ thị hiện tại có
            thể khác.
          </p>
          {rows.slice(page * 20, (page + 1) * 20).map((row) => (
            <article key={row.source_id} className="border-t border-line py-3">
              <p className="whitespace-pre-wrap break-words">
                {String(row.import_data.title ?? row.import_data.text ?? row.source_id)}
              </p>
              <details>
                <summary className="underline cursor-pointer">Chi tiết kỹ thuật nguồn</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(row, null, 2)}
                </pre>
              </details>
            </article>
          ))}
          <div className="flex gap-3 items-center">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
              Trang trước
            </Button>
            <span>
              {page + 1}/{Math.max(1, Math.ceil(rows.length / 20))}
            </span>
            <Button disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(page + 1)}>
              Trang sau
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function TrialGraph({
  projectId,
  runId,
  modelPath,
  builtModel,
  dimension,
}: {
  projectId: number;
  runId: string;
  modelPath: string;
  builtModel: string;
  dimension: number;
}) {
  const location = useLocation(),
    saved = location.state?.trialDraft;
  const draft = saved?.projectId === projectId && saved?.runId === runId ? saved : undefined;
  const [question, setQuestion] = useState(
    typeof draft?.question === "string" ? draft.question.slice(0, 4000) : "",
  );
  const [topK, setTopK] = useState(
    Number.isInteger(draft?.topK) && draft.topK >= 1 && draft.topK <= 10 ? draft.topK : 5,
  );
  const [expand, setExpand] = useState(draft?.expand === true);
  const [result, setResult] = useState<GraphRetrieval>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function retrieve() {
    if (pending.current || !question.trim()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(await runGraphRetrieval(projectId, runId, question, topK, expand));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Chưa thử được đồ thị. Kiểm model và kết nối.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 text-sm">
      <p>
        Tìm nguồn trong đồ thị đang xem; không tạo câu trả lời và không đổi đồ thị Chat. Gửi câu thử
        có thể tính phí Embedding.
      </p>
      <p>
        Đồ thị dựng bằng <strong className="break-all">{builtModel.split("|").pop()}</strong> ·{" "}
        {dimension.toLocaleString("vi-VN")} chiều. Embedding đang chọn phải trùng địa chỉ kết nối và
        tên model này; đổi model thì phải dựng lại đồ thị.
      </p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void retrieve();
        }}
      >
        <Field label="Câu hỏi thử">
          <textarea
            className={inputCls}
            maxLength={4000}
            required
            rows={3}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-4 items-end">
          <Field label="Số kết quả nguồn">
            <input
              className={inputCls}
              type="number"
              min={1}
              max={10}
              value={topK}
              onChange={(event) => setTopK(Number(event.target.value))}
            />
          </Field>
          <label className="flex gap-2 items-center min-h-10">
            <input
              type="checkbox"
              checked={expand}
              onChange={(event) => setExpand(event.target.checked)}
            />
            Tìm thêm nội dung liên quan
          </label>
        </div>
        <Button
          type="submit"
          disabled={busy || !question.trim() || !Number.isInteger(topK) || topK < 1 || topK > 10}
        >
          {busy ? "Đang tìm nguồn…" : "Thử truy xuất"}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <Link
        className="underline inline-block"
        to={modelPath}
        state={{ trialDraft: { projectId, runId, question, topK, expand } }}
      >
        Chỉnh model
      </Link>
      {result && (
        <>
          <p role="status">Tìm thấy {result.items.length} kết quả trong đồ thị đang chọn.</p>
          {result.items.map((item) => (
            <article
              key={`${item.entity_type}-${item.entity_id}`}
              className="border-t border-line py-4 space-y-3"
            >
              <h3 className="font-semibold break-words">
                {item.doc_id} · {item.unit_id ?? item.sign_id ?? "Văn bản"}
              </h3>
              {Object.entries(item.source_texts).map(([field, text]) => (
                <p key={field} className="whitespace-pre-wrap break-words">
                  {text}
                </p>
              ))}
              <details>
                <summary className="underline cursor-pointer">Chi tiết kỹ thuật và quan hệ</summary>
                <pre className="whitespace-pre-wrap break-all text-xs mt-3">
                  {JSON.stringify(item, null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </>
      )}
    </section>
  );
}

function SelectedGraph({
  projectId,
  links,
}: {
  projectId: number;
  links: BuilderConfiguration["links"];
}) {
  const load = useCallback(
    (signal?: AbortSignal) => loadGraphProject(projectId, signal),
    [projectId],
  );
  const data = useInspection(load),
    value = data.value,
    neo4j = value && builderNeo4jLink(links, value.target.database);
  return (
    <section className="space-y-4 text-sm">
      <Notice {...data} retry={data.reload} />
      {value && (
        <>
          <h3 className="font-semibold text-lg break-words">{value.target.project_name}</h3>
          <dl className="grid grid-cols-3 gap-3">
            {(
              [
                ["Nội dung", value.counts.nodes],
                ["Liên kết", value.counts.edges],
                ["Vector", value.counts.vectors],
              ] as const
            ).map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="text-xl font-semibold">{count.toLocaleString("vi-VN")}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted">
            Đọc từ nơi lưu lúc {new Date(value.measured_at).toLocaleString("vi-VN")}. Số liệu có thể
            thay đổi khi đang dựng.
          </p>
          <details>
            <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
            <div className="mt-3 space-y-3">
              <p className="break-all">
                Project #{value.target.project_id} · database {value.target.database} · namespace{" "}
                {value.target.namespace} · {value.database_id}
              </p>
              {neo4j && (
                <a className="underline" target="_blank" rel="noreferrer" href={neo4j}>
                  Mở Neo4j
                </a>
              )}
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(
                  { labels: value.labels, relations: value.relations, indexes: value.indexes },
                  null,
                  2,
                )}
              </pre>
            </div>
          </details>
        </>
      )}
      <Button disabled={data.loading} onClick={data.reload}>
        Tải lại số liệu
      </Button>
    </section>
  );
}
