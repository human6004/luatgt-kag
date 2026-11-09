import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { SignRecord } from "./demo-import-data";

/* ---------- Types ---------- */
export type DocStatus =
  | "Chờ xử lý"
  | "Đang xử lý"
  | "Chờ duyệt"
  | "Đã lập chỉ mục"
  | "Lưu trữ"
  | "Lỗi";
export interface LegalDoc {
  id: string;
  name: string;
  type: "Luật" | "Nghị định" | "Thông tư" | "Quyết định";
  effective: string;
  status: DocStatus;
  chunks: number;
  entities: number;
  step: number; // 0..5 pipeline progress
  updated: string;
}

export type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";
export interface Job {
  id: string;
  taskId: string;
  title: string;
  command: string;
  status: JobStatus;
  progress: number;
  logs: string[];
  startedAt: string;
  duration?: number;
}

export interface QBankItem {
  id: string;
  chapter: string;
  question: string;
  options: string[];
  answer: number;
  critical: boolean;
  explanation: string;
  source: string;
}

export interface ChatLog {
  id: string;
  user: string;
  question: string;
  answer: string;
  latency: number;
  feedback: "up" | "down" | null;
  status:
    | "Đã trả lời"
    | "Không có căn cứ"
    | "Phản hồi sai"
    | "Văn bản hết hiệu lực";
  resolved: boolean;
  time: string;
}

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: "Người học" | "Biên tập viên" | "Cảnh sát" | "Quản trị viên";
  licenseClass: string;
  questions: number;
  active: boolean;
  joined: string;
}

export interface KagConfig {
  bizScene: "legal" | "default";
  language: "vi" | "en";
  hostAddr: string;
  openieModel: string;
  chatModel: string;
  vectorModel: string;
  baseUrl: string;
  apiKey: string;
  chainNum: number;
  threadNum: number;
  splitLength: number;
  splitOverlap: number;
  similarityThreshold: number | null;
  evalThreads: number;
  evalUpperLimit: number;
  topK: number;
  kgCsThreshold: number;
  kgFrTopK: number;
  kgFrThreshold: number;
  rcTopK: number;
  rcScoreThreshold: number;
  enableRef: boolean;
  solverVariant: "baseline" | "evidence_aware";
}

/* ---------- Task catalog (UI replacements for CLI commands) ---------- */
export interface TaskDef {
  id: string;
  group: "Hạ tầng" | "Dự án" | "Nạp dữ liệu" | "Đánh giá" | "Kiểm tra";
  title: string;
  desc: string;
  command: string;
  steps: string[];
}

export const tasks: TaskDef[] = [
  {
    id: "infra-up",
    group: "Hạ tầng",
    title: "Khởi động dịch vụ OpenSPG",
    desc: "Bật neo4j, mysql, minio và openspg-server.",
    command: "docker compose -f deploy/docker-compose.yml up -d",
    steps: [
      "Pull image release-openspg-*",
      "Khởi động release-openspg-mysql",
      "Khởi động release-openspg-neo4j",
      "Khởi động release-openspg-minio",
      "Khởi động release-openspg-server",
      "Healthcheck http://127.0.0.1:8887 → 200 OK",
    ],
  },
  {
    id: "docker-build",
    group: "Hạ tầng",
    title: "Build image riêng",
    desc: "Build kag-legal-* từ deploy/ (không phụ thuộc compose gốc).",
    command: "deploy/build.sh",
    steps: [
      "Đọc deploy/.env",
      "Build kag-legal-mysql (FROM openspg-mysql)",
      "Build kag-legal-neo4j + restore-entrypoint",
      "Build kag-legal-minio",
      "Build kag-legal-server + start.sh",
      "Build kag-legal-app (python:3.10-slim)",
      "Build kag-legal-web (node → nginx)",
      "Gắn tag ${TAG} ✓",
    ],
  },
  {
    id: "docker-pack",
    group: "Hạ tầng",
    title: "Đóng gói để chia sẻ",
    desc: "docker save toàn bộ image + compose + dump thành một tệp.",
    command: "deploy/pack.sh",
    steps: [
      "docker compose config --images",
      "docker save | gzip → images/kag-legal.tar.gz",
      "Chép docker-compose.yml, env.example, install.sh/.ps1",
      "Kèm dumps/legal.dump",
      "Bỏ khối build: khỏi compose",
      "Sinh SHA256SUMS",
      "Ghi dist/kag-legal-bundle.tar.gz ✓",
    ],
  },
  {
    id: "infra-check",
    group: "Hạ tầng",
    title: "Kiểm tra container",
    desc: "Liệt kê trạng thái container và volume.",
    command: "docker ps -a && docker compose config --volumes",
    steps: [
      "release-openspg-server   Up 3 hours",
      "release-openspg-neo4j    Up 3 hours",
      "release-openspg-mysql    Up 3 hours",
      "release-openspg-minio    Up 3 hours",
      "Volumes: neo4j-data, mysql-data, minio-data",
    ],
  },
  {
    id: "project-restore",
    group: "Dự án",
    title: "Đăng ký dự án KAG",
    desc: "Khôi phục project legal lên OpenSPG server.",
    command:
      "knext project restore --host_addr http://127.0.0.1:8887 --proj_path .",
    steps: [
      "Đọc kag_config.yaml (UTF-8)",
      "Kết nối host_addr",
      "Tạo namespace Legal",
      "Ghi project_id vào cấu hình",
    ],
  },
  {
    id: "schema-commit",
    group: "Dự án",
    title: "Commit schema",
    desc: "Đẩy schema Điều/Khoản/Điểm, Hành vi, Chế tài.",
    command: "knext schema commit",
    steps: [
      "Phân tích Legal.schema",
      "Kiểm tra check_schema.py",
      "Tạo kiểu Văn bản, Điều, Khoản, Điểm",
      "Tạo kiểu HànhVi, ChếTài, PhươngTiện",
      "Commit thành công",
    ],
  },
  {
    id: "metadata",
    group: "Nạp dữ liệu",
    title: "Metadata → đồ thị",
    desc: "Chuyển metadata/*.json thành nodes/edges.",
    command: "python builder/metadata_to_graph.py",
    steps: [
      "Đọc metadata/*.json",
      "Áp dụng PROP_MAP / REL_MAP",
      "Sinh canon_id cho nút",
      "Ghi data/graph/nodes.json",
      "Ghi data/graph/edges.json",
    ],
  },
  {
    id: "inject",
    group: "Nạp dữ liệu",
    title: "Inject tri thức miền",
    desc: "Nạp đồ thị ngoài qua domain_kg_inject_chain.",
    command: "python builder/injection.py",
    steps: [
      "Tải nodes.json / edges.json",
      "Khởi tạo domain_kg_inject_chain",
      "Vector hoá thuộc tính",
      "kg_writer → neo4j",
      "Hoàn tất inject",
    ],
  },
  {
    id: "index",
    group: "Nạp dữ liệu",
    title: "Lập chỉ mục văn bản",
    desc: "Chạy BuilderChainRunner trên processed/*.md.",
    command: "python builder/indexer.py",
    steps: [
      "dir_file_scanner: quét thư mục",
      "legal_md_reader: giữ số Khoản/Điểm",
      "length_splitter (4950/100)",
      "legal_schema_free_extractor",
      "batch_vectorizer",
      "kag_post_processor",
      "kg_writer → đồ thị",
    ],
  },
  {
    id: "eval",
    group: "Đánh giá",
    title: "Chạy bộ câu hỏi kiểm thử",
    desc: "Đánh giá hit@k trên bộ câu hỏi chuẩn.",
    command: "python solver/eval.py",
    steps: [
      "Tải bộ câu hỏi",
      "Khởi tạo solver pipeline",
      "Truy vấn KAG (thread_num)",
      "Chuẩn hoá NFC & markdown",
      "Tính hit_rate / hit_all",
      "Ghi runs/benchmark.txt",
    ],
  },
  {
    id: "benchmark",
    group: "Đánh giá",
    title: "So sánh KAG vs HybridRAG",
    desc: "Benchmark ba hệ thống trên cùng tập.",
    command: "python -m benchmark.evaluator.evaluate",
    steps: [
      "Load final_150_corpus_verified.json (150 câu)",
      "Runner kag_runner → benchmark/runs/kag.json",
      "Runner hybridrag_runner → hybridrag.json",
      "Runner nativerag_runner → nativerag.json",
      "citation_parser: parse citations từ answer",
      "retrieval / citation / answer / grounding / abstention metrics",
      "Bootstrap CI & aggregate",
      "Ghi report.json",
    ],
  },
  {
    id: "tests",
    group: "Kiểm tra",
    title: "Chạy kiểm thử builder",
    desc: "check_prompts, reader, predicate binding…",
    command: "pytest tests/builder",
    steps: [
      "check_prompts.py ✓",
      "test_reader_fixes.py ✓",
      "test_predicate_binding.py ✓",
      "test_stop_handler.py ✓",
      "test_builder_fixes.py ✓",
    ],
  },
  {
    id: "secret",
    group: "Kiểm tra",
    title: "Quét lộ khoá bí mật",
    desc: "Đảm bảo không commit API key.",
    command: "python scripts/secret_scan.py",
    steps: [
      "Quét 412 tệp",
      "Bỏ qua kag_config.yaml (gitignore)",
      "Không phát hiện khoá lộ",
    ],
  },
  {
    id: "export",
    group: "Kiểm tra",
    title: "Xuất đồ thị",
    desc: "Sao lưu neo4j ra dist/legal.dump.",
    command: "docker/xuat-do-thi.ps1",
    steps: [
      "Dừng ghi neo4j",
      "neo4j-admin database dump",
      "Ghi dist/legalfinalcand.dump (1.31 GiB)",
      "Sinh legalfinalcand.dump.sha256",
      "Bật lại neo4j",
    ],
  },
  {
    id: "restore",
    group: "Kiểm tra",
    title: "Khôi phục đồ thị",
    desc: "Nạp dump vào database legalfinalcand trên máy nhận.",
    command: "docker/restore-final-graph.ps1",
    steps: [
      "Xác minh sha256 = 155c1e74…",
      "Dừng release-openspg-neo4j",
      "neo4j-admin database load legalfinalcand",
      "Khởi động neo4j",
      "Đếm lại: 15888 nodes / 32655 relations",
      "vector_dimensions 3072 ✓",
    ],
  },
];

export const defaultConfig: KagConfig = {
  bizScene: "legal",
  language: "vi",
  hostAddr: "http://127.0.0.1:8887",
  openieModel: "qwen2.5-72b-instruct",
  chatModel: "qwen2.5-72b-instruct",
  vectorModel: "bge-m3",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  chainNum: 2,
  threadNum: 2,
  splitLength: 4950,
  splitOverlap: 100,
  similarityThreshold: null,
  evalThreads: 8,
  evalUpperLimit: 150,
  topK: 20,
  kgCsThreshold: 0.9,
  kgFrTopK: 20,
  kgFrThreshold: 0.8,
  rcTopK: 20,
  rcScoreThreshold: 0.65,
  enableRef: true,
  solverVariant: "baseline",
};

/* ---------- Store ---------- */
interface Store {
  docs: LegalDoc[];
  setDocs: React.Dispatch<React.SetStateAction<LegalDoc[]>>;
  jobs: Job[];
  runTask: (
    taskId: string,
    opts?: { label?: string; onDone?: () => void },
  ) => string;
  cancelJob: (id: string) => void;
  qbank: QBankItem[];
  signs: SignRecord[];
  setSigns: React.Dispatch<React.SetStateAction<SignRecord[]>>;
  setQbank: React.Dispatch<React.SetStateAction<QBankItem[]>>;
  logs: ChatLog[];
  setLogs: React.Dispatch<React.SetStateAction<ChatLog[]>>;
  users: AppUser[];
  setUsers: React.Dispatch<React.SetStateAction<AppUser[]>>;
  config: KagConfig;
  setConfig: React.Dispatch<React.SetStateAction<KagConfig>>;
  lastEval: { hit: number; total: number; time: string } | null;
  toast: string | null;
  notify: (msg: string) => void;
}

const Ctx = createContext<Store | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [docs, setDocs] = useState<LegalDoc[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [qbank, setQbank] = useState<QBankItem[]>([]);
  const [signs, setSigns] = useState<SignRecord[]>([]);
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [config, setConfig] = useState(defaultConfig);
  const lastEval: Store["lastEval"] = null;
  const [toast, setToast] = useState<string | null>(null);
  const timers = useRef<Record<string, number>>({});
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const runTask: Store["runTask"] = useCallback(
    (taskId, opts) => {
      const def = tasks.find((t) => t.id === taskId)!;
      const id = "j" + Date.now();
      const start = Date.now();
      const command = opts?.label
        ? `${def.command} ${opts.label}`
        : def.command;
      setJobs((js) => [
        {
          id,
          taskId,
          title: def.title,
          command,
          status: "running",
          progress: 0,
          logs: [`$ ${command}`],
          startedAt: now(),
        },
        ...js,
      ]);
      let i = 0;
      timers.current[id] = window.setInterval(() => {
        const line = def.steps[i];
        i++;
        const done = i >= def.steps.length;
        setJobs((js) =>
          js.map((j) => {
            if (j.id !== id || j.status !== "running") return j;
            const ts = new Date().toLocaleTimeString("vi-VN");
            const extra =
              done && taskId === "eval"
                ? [`[${ts}] hit@${config.topK} = 0.874 (145/166)`]
                : [];
            return {
              ...j,
              progress: Math.round((i / def.steps.length) * 100),
              logs: [
                ...j.logs,
                `[${ts}] ${line}`,
                ...extra,
                ...(done
                  ? [
                      `✓ Hoàn tất trong ${Math.round((Date.now() - start) / 1000)}s`,
                    ]
                  : []),
              ],
              status: done ? "success" : "running",
              duration: done
                ? Math.round((Date.now() - start) / 1000)
                : undefined,
            };
          }),
        );
        if (done) {
          window.clearInterval(timers.current[id]);
          opts?.onDone?.();
        }
      }, 700);
      return id;
    },
    [config.topK],
  );

  const cancelJob = useCallback((id: string) => {
    window.clearInterval(timers.current[id]);
    setJobs((js) =>
      js.map((j) =>
        j.id === id && j.status === "running"
          ? {
              ...j,
              status: "cancelled",
              logs: [...j.logs, "✗ Đã huỷ bởi quản trị viên"],
            }
          : j,
      ),
    );
  }, []);

  return (
    <Ctx.Provider
      value={{
        docs,
        setDocs,
        jobs,
        runTask,
        cancelJob,
        qbank,
        setQbank,
        signs,
        setSigns,
        logs,
        setLogs,
        users,
        setUsers,
        config,
        setConfig,
        lastEval,
        toast,
        notify,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAdmin() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAdmin outside AdminProvider");
  return c;
}
