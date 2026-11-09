import { useState, useMemo } from "react";
import { Link } from "react-router-dom";

export type SignCategory =
  | "all"
  | "cam"
  | "nguyhiem"
  | "hieulenh"
  | "chidan"
  | "phu";

export interface SignItem {
  id: string;
  code: string;
  name: string;
  category: SignCategory;
  categoryLabel: string;
  shortDesc: string;
  meaning: string;
  applicableCases: string;
  relatedViolations: {
    title: string;
    fineRange: string;
    demerit?: string;
    clause: string;
  }[];
  shape:
    | "circle-red"
    | "triangle-yellow"
    | "circle-blue"
    | "rect-blue"
    | "rect-white";
  iconType: string;
}

const mockSigns: SignItem[] = [
  {
    id: "s101",
    code: "P.101",
    name: "Đường cấm",
    category: "cam",
    categoryLabel: "Biển báo cấm",
    shortDesc:
      "Cấm tất cả các loại phương tiện cơ giới và thô sơ đi lại theo cả hai hướng",
    meaning:
      "Biển báo đường cấm tất cả các loại phương tiện (cơ giới và thô sơ) đi lại theo cả hai hướng, trừ các xe được ưu tiên theo quy định của pháp luật (xe cứu hỏa, xe quân sự, công an, cứu thương khi làm nhiệm vụ khẩn cấp).",
    applicableCases:
      "Đặt ở đầu tuyến đường hoặc khu vực cấm lưu thông hoàn toàn các phương tiện, như khu phố đi bộ, đoạn đường đang sửa chữa lớn hoặc bảo vệ an ninh trật tự.",
    relatedViolations: [
      {
        title:
          "Đi vào đường có biển báo hiệu có nội dung cấm đi vào đối với xe máy",
        fineRange: "400.000 VNĐ - 600.000 VNĐ",
        demerit: "Trừ 01 điểm GPLX",
        clause: "Điều 7 Khoản 3 Điểm i NĐ 168/2024",
      },
      {
        title:
          "Đi vào đường có biển cấm phương tiện đang điều khiển đối với ô tô",
        fineRange: "2.000.000 VNĐ - 3.000.000 VNĐ",
        demerit: "Trừ 02 điểm GPLX",
        clause: "Điều 6 Khoản 4 Điểm b NĐ 168/2024",
      },
    ],
    shape: "circle-red",
    iconType: "p101",
  },
  {
    id: "s102",
    code: "P.102",
    name: "Cấm đi ngược chiều",
    category: "cam",
    categoryLabel: "Biển báo cấm",
    shortDesc:
      "Cấm tất cả các loại xe cơ giới và thô sơ đi vào theo chiều đặt biển",
    meaning:
      "Báo hiệu đường cấm tất cả các loại xe (cơ giới và thô sơ) đi vào theo chiều đặt biển, trừ các xe được ưu tiên theo quy định đang phát tín hiệu ưu tiên. Chiều ngược lại được phép lưu thông bình thường hoặc là đường một chiều.",
    applicableCases:
      "Đặt ở đầu tuyến đường một chiều hoặc lối ra từ đường nhánh giao với đường chính.",
    relatedViolations: [
      {
        title: "Xe máy đi ngược chiều trên đường có biển Cấm đi ngược chiều",
        fineRange: "1.000.000 VNĐ - 2.000.000 VNĐ",
        demerit: "Trừ 02 điểm GPLX, tước GPLX 1-3 tháng",
        clause: "Điều 7 Khoản 5 Điểm a NĐ 168/2024",
      },
      {
        title: "Xe ô tô đi ngược chiều trên đường có biển Cấm đi ngược chiều",
        fineRange: "4.000.000 VNĐ - 6.000.000 VNĐ",
        demerit: "Trừ 03 điểm GPLX, tước GPLX 2-4 tháng",
        clause: "Điều 6 Khoản 5 Điểm c NĐ 168/2024",
      },
    ],
    shape: "circle-red",
    iconType: "p102",
  },
  {
    id: "s103a",
    code: "P.103a",
    name: "Cấm xe ô tô",
    category: "cam",
    categoryLabel: "Biển báo cấm",
    shortDesc:
      "Cấm các loại xe cơ giới kể cả xe 3 bánh có thùng đi qua (trừ xe máy 2 bánh)",
    meaning:
      "Báo đường cấm tất cả các loại xe cơ giới kể cả xe ba bánh có thùng đi qua, trừ xe mô tô hai bánh, xe gắn máy và các xe được ưu tiên theo quy định.",
    applicableCases:
      "Được đặt trên các tuyến phố hẹp, cầu có tải trọng hạn chế hoặc trung tâm đô thị cần giảm ùn tắc ô tô vào giờ cao điểm.",
    relatedViolations: [
      {
        title: "Điều khiển xe ô tô đi vào đường có biển báo cấm xe ô tô",
        fineRange: "2.000.000 VNĐ - 3.000.000 VNĐ",
        demerit: "Trừ 02 điểm GPLX",
        clause: "Điều 6 Khoản 4 Điểm b NĐ 168/2024",
      },
    ],
    shape: "circle-red",
    iconType: "p103a",
  },
  {
    id: "s123a",
    code: "P.123a",
    name: "Cấm rẽ trái",
    category: "cam",
    categoryLabel: "Biển báo cấm",
    shortDesc:
      "Cấm các loại phương tiện rẽ trái tại nút giao (không cấm quay đầu theo QCVN 41:2019)",
    meaning:
      "Báo hiệu cấm rẽ trái tại vị trí đường giao nhau. Theo Quy chuẩn 41:2019/BGTVT mới nhất, biển cấm rẽ trái KHÔNG còn cấm quay đầu xe trừ khi có biển cấm quay đầu riêng.",
    applicableCases:
      "Đặt trước nút giao hoặc ngã ba, ngã tư có lưu lượng xung đột hướng rẽ trái cao nhằm tránh ùn tắc.",
    relatedViolations: [
      {
        title: "Không chấp hành chỉ dẫn của biển báo hiệu cấm rẽ trái (ô tô)",
        fineRange: "300.000 VNĐ - 500.000 VNĐ",
        demerit: "Không trừ điểm (trừ khi gây tai nạn)",
        clause: "Điều 6 Khoản 1 Điểm a NĐ 168/2024",
      },
      {
        title: "Không chấp hành chỉ dẫn của biển báo hiệu cấm rẽ trái (xe máy)",
        fineRange: "100.000 VNĐ - 200.000 VNĐ",
        demerit: "Không trừ điểm",
        clause: "Điều 7 Khoản 1 Điểm a NĐ 168/2024",
      },
    ],
    shape: "circle-red",
    iconType: "p123a",
  },
  {
    id: "s127",
    code: "P.127",
    name: "Tốc độ tối đa cho phép (60 km/h)",
    category: "cam",
    categoryLabel: "Biển báo cấm",
    shortDesc:
      "Cấm các loại xe chạy với tốc độ tối đa vượt quá giá trị ghi trên biển",
    meaning:
      "Báo tốc độ tối đa cho phép các xe cơ giới vận hành không được vượt quá số ghi trên mặt biển (tính bằng km/h).",
    applicableCases:
      "Đặt ở những đoạn đường tiềm ẩn nguy cơ tai nạn, khúc cua dốc, gần trường học, bệnh viện hoặc khu đông dân cư.",
    relatedViolations: [
      {
        title: "Chạy quá tốc độ từ 5 đến dưới 10 km/h (ô tô)",
        fineRange: "800.000 VNĐ - 1.000.000 VNĐ",
        demerit: "Không trừ điểm",
        clause: "Điều 6 Khoản 3 Điểm a NĐ 168/2024",
      },
      {
        title: "Chạy quá tốc độ từ 10 đến 20 km/h (ô tô)",
        fineRange: "4.000.000 VNĐ - 6.000.000 VNĐ",
        demerit: "Trừ 02 điểm GPLX",
        clause: "Điều 6 Khoản 5 Điểm i NĐ 168/2024",
      },
    ],
    shape: "circle-red",
    iconType: "p127",
  },
  {
    id: "w201a",
    code: "W.201a",
    name: "Chỗ ngoặt nguy hiểm vòng bên trái",
    category: "nguyhiem",
    categoryLabel: "Biển báo nguy hiểm",
    shortDesc:
      "Báo trước sắp đến một chỗ ngoặt nguy hiểm vòng sang phía bên trái",
    meaning:
      "Báo trước sắp đến chỗ ngoặt gấp vòng sang bên trái, có thể bị che khuất tầm nhìn hoặc trơn trượt.",
    applicableCases:
      "Đặt trước khúc cua bán kính nhỏ ngoài khu đông dân cư từ 100m - 300m, trong nội đô từ 50m.",
    relatedViolations: [
      {
        title: "Vượt xe tại nơi đường cong tầm nhìn bị che khuất (ô tô)",
        fineRange: "4.000.000 VNĐ - 6.000.000 VNĐ",
        demerit: "Trừ 02 điểm GPLX, tước GPLX 1-3 tháng",
        clause: "Điều 6 Khoản 5 Điểm d NĐ 168/2024",
      },
    ],
    shape: "triangle-yellow",
    iconType: "w201a",
  },
  {
    id: "w207a",
    code: "W.207a",
    name: "Giao nhau với đường không ưu tiên",
    category: "nguyhiem",
    categoryLabel: "Biển báo nguy hiểm",
    shortDesc:
      "Báo trước sắp đến nơi giao nhau với đường không ưu tiên (đang đi trên đường ưu tiên)",
    meaning:
      "Đặt trên đường ưu tiên để báo trước sắp đến nơi giao nhau với đường không ưu tiên (đường nhánh). Xe trên tuyến đường này được quyền ưu tiên đi trước qua nơi giao nhau.",
    applicableCases:
      "Đặt tại các tuyến quốc lộ, tỉnh lộ trước điểm giao với ngõ, hẻm, đường giao thông nông thôn.",
    relatedViolations: [
      {
        title:
          "Không giảm tốc độ và không nhường đường cho xe trên đường ưu tiên từ đường nhánh ra",
        fineRange: "800.000 VNĐ - 1.000.000 VNĐ (ô tô)",
        demerit: "Không trừ điểm (trừ tai nạn)",
        clause: "Điều 6 Khoản 3 Điểm c NĐ 168/2024",
      },
    ],
    shape: "triangle-yellow",
    iconType: "w207a",
  },
  {
    id: "w210",
    code: "W.210",
    name: "Giao nhau với đường sắt có rào chắn",
    category: "nguyhiem",
    categoryLabel: "Biển báo nguy hiểm",
    shortDesc:
      "Báo trước sắp đến nơi giao nhau giữa đường bộ và đường sắt có rào chắn kín hoặc nửa kín",
    meaning:
      "Báo trước cho người tham gia giao thông sắp đến đoạn giao cắt đồng mức với đường sắt được trang bị chắn tự động hoặc nhân viên gác chắn.",
    applicableCases:
      "Đặt trước đường ngang giao cắt có chắn đường sắt, yêu cầu giảm tốc độ và sẵn sàng dừng lại khi có chuông/đèn đỏ.",
    relatedViolations: [
      {
        title: "Vượt rào chắn đường ngang khi chắn đang đóng hoặc chuông kêu",
        fineRange: "4.000.000 VNĐ - 6.000.000 VNĐ (ô tô)",
        demerit: "Trừ 03 điểm GPLX, tước GPLX 2-4 tháng",
        clause: "Điều 47 NĐ 168/2024",
      },
    ],
    shape: "triangle-yellow",
    iconType: "w210",
  },
  {
    id: "r301a",
    code: "R.301a",
    name: "Hướng đi phải theo (Các xe chỉ được đi thẳng)",
    category: "hieulenh",
    categoryLabel: "Biển hiệu lệnh",
    shortDesc:
      "Báo hiệu các phương tiện chỉ được phép đi thẳng qua nơi giao nhau",
    meaning:
      "Bắt buộc người điều khiển xe chỉ được phép đi thẳng tại ngã ba, ngã tư hoặc nơi giao lộ. Không được phép rẽ trái, rẽ phải hoặc quay đầu xe.",
    applicableCases:
      "Đặt trước ngã tư hoặc các nút giao phức hợp nhằm phân luồng chống xung đột hướng đi.",
    relatedViolations: [
      {
        title:
          "Không chấp hành hiệu lệnh của biển báo hiệu hiệu lệnh rẽ/đi thẳng (ô tô)",
        fineRange: "300.000 VNĐ - 500.000 VNĐ",
        demerit: "Không trừ điểm",
        clause: "Điều 6 Khoản 1 Điểm a NĐ 168/2024",
      },
      {
        title: "Không chấp hành hiệu lệnh của biển chỉ dẫn/hiệu lệnh (xe máy)",
        fineRange: "100.000 VNĐ - 200.000 VNĐ",
        demerit: "Không trừ điểm",
        clause: "Điều 7 Khoản 1 Điểm a NĐ 168/2024",
      },
    ],
    shape: "circle-blue",
    iconType: "r301a",
  },
  {
    id: "r303",
    code: "R.303",
    name: "Nơi giao nhau chạy theo vòng xuyến",
    category: "hieulenh",
    categoryLabel: "Biển hiệu lệnh",
    shortDesc:
      "Báo hiệu các xe phải chạy vòng quanh đảo an toàn theo chiều mũi tên",
    meaning:
      "Báo cho người tham gia giao thông biết sắp vào nút giao thông đảo tròn (bùng binh). Phải tuân thủ quy tắc nhường đường cho xe từ bên trái tới trong vòng xuyến.",
    applicableCases: "Đặt tại các quảng trường, nút giao đảo tròn lớn.",
    relatedViolations: [
      {
        title:
          "Không nhường đường cho xe đi bên trái tại nơi có báo hiệu vòng xuyến",
        fineRange: "400.000 VNĐ - 600.000 VNĐ (ô tô)",
        demerit: "Không trừ điểm",
        clause: "Điều 6 Khoản 2 Điểm e NĐ 168/2024",
      },
    ],
    shape: "circle-blue",
    iconType: "r303",
  },
  {
    id: "i401",
    code: "I.401",
    name: "Bắt đầu đường ưu tiên",
    category: "chidan",
    categoryLabel: "Biển chỉ dẫn",
    shortDesc:
      "Chỉ dẫn cho người tham gia giao thông biết bắt đầu đoạn đường được ưu tiên",
    meaning:
      "Biểu thị cho các phương tiện trên tuyến đường này được quyền ưu tiên đi trước qua các nơi giao nhau có các nhánh giao cắt khác.",
    applicableCases:
      "Đặt tại điểm khởi đầu của tuyến trục chính xuyên tâm, quốc lộ hoặc đại lộ đô thị.",
    relatedViolations: [],
    shape: "rect-white",
    iconType: "i401",
  },
  {
    id: "i407a",
    code: "I.407a",
    name: "Đường một chiều",
    category: "chidan",
    categoryLabel: "Biển chỉ dẫn",
    shortDesc:
      "Chỉ dẫn đoạn đường chỉ cho phép các loại phương tiện đi theo chiều mũi tên",
    meaning:
      "Báo hiệu đoạn đường một chiều, mọi phương tiện chỉ được phép di chuyển theo chiều mũi tên chỉ dẫn. Không được quay đầu xe (trừ xe ưu tiên) và không được lùi xe.",
    applicableCases:
      "Đặt sau nơi đường giao nhau trên tuyến phố được tổ chức lưu thông 1 chiều.",
    relatedViolations: [
      {
        title: "Lùi xe ở đường một chiều (ô tô)",
        fineRange: "800.000 VNĐ - 1.000.000 VNĐ",
        demerit: "Không trừ điểm (trừ tai nạn)",
        clause: "Điều 6 Khoản 3 Điểm e NĐ 168/2024",
      },
    ],
    shape: "rect-blue",
    iconType: "i407a",
  },
  {
    id: "s501",
    code: "S.501",
    name: "Phạm vi tác dụng của biển (Khoảng cách)",
    category: "phu",
    categoryLabel: "Biển phụ",
    shortDesc:
      "Thông báo chiều dài đoạn đường áp dụng hiệu lực của biển chính (VD: 500m)",
    meaning:
      "Biển phụ đặt dưới các biển báo cấm hoặc biển hiệu lệnh để chỉ rõ chiều dài đoạn đường nguy hiểm hoặc đoạn đường chịu sự kiểm soát của biển chính tính từ vị trí cắm biển.",
    applicableCases:
      "Thường kết hợp dưới biển cấm dừng cấm đỗ, hạn chế tốc độ, cấm bóp còi.",
    relatedViolations: [],
    shape: "rect-white",
    iconType: "s501",
  },
];

// Render SVG graphic for realistic traffic sign representation
function TrafficSignSvg({
  shape,
  iconType,
}: {
  shape: SignItem["shape"];
  iconType: string;
}) {
  if (shape === "circle-red") {
    return (
      <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xs">
        {/* Outer Red Ring */}
        <circle cx="50" cy="50" r="46" fill="#dc2626" />
        {/* Inner White Field */}
        <circle cx="50" cy="50" r="37" fill="#ffffff" />
        {/* Sign Specific Graphic */}
        {iconType === "p101" &&
          // Đường cấm: trắng trơn trong viền đỏ
          null}
        {iconType === "p102" && (
          // Cấm đi ngược chiều: thanh ngang trắng trên nền đỏ
          <>
            <circle cx="50" cy="50" r="46" fill="#dc2626" />
            <rect x="18" y="42" width="64" height="16" rx="2" fill="#ffffff" />
          </>
        )}
        {iconType === "p103a" && (
          // Cấm ô tô: hình ô tô con màu đen + vạch chéo đỏ
          <g>
            <path
              d="M30 45 L35 34 Q36 32 40 32 L60 32 Q64 32 65 34 L70 45 L74 48 Q76 50 76 53 L76 63 Q76 65 74 65 L72 65 Q72 68 70 70 Q68 72 65 72 L61 72 Q59 72 58 70 L58 65 L42 65 L42 70 Q41 72 39 72 L35 72 Q32 72 30 70 L30 65 L26 65 Q24 65 24 63 L24 53 Q24 50 26 48 Z"
              fill="#102a45"
            />
            <circle cx="34" cy="56" r="3.5" fill="#ffffff" />
            <circle cx="66" cy="56" r="3.5" fill="#ffffff" />
            <path d="M36 36 L64 36 L67 44 L33 44 Z" fill="#ffffff" />
            <line
              x1="20"
              y1="20"
              x2="80"
              y2="80"
              stroke="#dc2626"
              strokeWidth="7"
              strokeLinecap="round"
            />
          </g>
        )}
        {iconType === "p123a" && (
          // Cấm rẽ trái
          <g>
            <path
              d="M56 68 L56 46 Q56 38 48 38 L38 38 L38 30 L22 42 L38 54 L38 46 L46 46 Q48 46 48 50 L48 68 Z"
              fill="#102a45"
            />
            <line
              x1="22"
              y1="22"
              x2="78"
              y2="78"
              stroke="#dc2626"
              strokeWidth="7"
              strokeLinecap="round"
            />
          </g>
        )}
        {iconType === "p127" && (
          // Giới hạn tốc độ 60
          <text
            x="50"
            y="60"
            textAnchor="middle"
            fill="#102a45"
            fontSize="30"
            fontWeight="900"
            fontFamily="sans-serif"
          >
            60
          </text>
        )}
      </svg>
    );
  }

  if (shape === "triangle-yellow") {
    return (
      <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xs">
        {/* Yellow triangle with red border */}
        <polygon
          points="50,10 92,86 8,86"
          fill="#eab308"
          stroke="#dc2626"
          strokeWidth="8"
          strokeLinejoin="round"
        />
        {iconType === "w201a" && (
          // Khúc ngoặt trái
          <path
            d="M58 76 L58 56 Q58 44 46 44 L38 44 L38 36 L24 48 L38 60 L38 52 L48 52 Q50 52 50 58 L50 76 Z"
            fill="#102a45"
          />
        )}
        {iconType === "w207a" && (
          // Giao với đường không ưu tiên
          <g>
            <line
              x1="50"
              y1="36"
              x2="50"
              y2="74"
              stroke="#102a45"
              strokeWidth="10"
              strokeLinecap="square"
            />
            <line
              x1="28"
              y1="55"
              x2="72"
              y2="55"
              stroke="#102a45"
              strokeWidth="5"
              strokeLinecap="square"
            />
          </g>
        )}
        {iconType === "w210" && (
          // Đường sắt có rào chắn
          <g stroke="#102a45" strokeWidth="3" fill="none">
            <line x1="26" y1="52" x2="74" y2="52" strokeWidth="4" />
            <line x1="26" y1="64" x2="74" y2="64" strokeWidth="4" />
            <line x1="34" y1="46" x2="34" y2="70" />
            <line x1="44" y1="46" x2="44" y2="70" />
            <line x1="56" y1="46" x2="56" y2="70" />
            <line x1="66" y1="46" x2="66" y2="70" />
            <polygon points="50,38 34,46 66,46" fill="#102a45" />
          </g>
        )}
      </svg>
    );
  }

  if (shape === "circle-blue") {
    return (
      <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xs">
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="#2563eb"
          stroke="#ffffff"
          strokeWidth="3"
        />
        {iconType === "r301a" && (
          // Chỉ đi thẳng
          <path
            d="M50 20 L35 38 L45 38 L45 78 L55 78 L55 38 L65 38 Z"
            fill="#ffffff"
          />
        )}
        {iconType === "r303" && (
          // Vòng xuyến: 3 mũi tên tròn
          <g fill="#ffffff">
            <path d="M50 24 A26 26 0 0 1 76 50 L82 50 L73 62 L64 50 L70 50 A20 20 0 0 0 50 30 Z" />
            <path d="M72 63 A26 26 0 0 1 37 72 L34 77 L31 63 L45 66 L41 71 A20 20 0 0 0 67 60 Z" />
            <path d="M28 57 A26 26 0 0 1 42 25 L41 19 L53 26 L44 35 L43 29 A20 20 0 0 0 31 52 Z" />
          </g>
        )}
      </svg>
    );
  }

  if (shape === "rect-blue") {
    return (
      <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xs">
        <rect
          x="8"
          y="10"
          width="84"
          height="80"
          rx="10"
          fill="#2563eb"
          stroke="#ffffff"
          strokeWidth="3"
        />
        {iconType === "i407a" && (
          // Đường 1 chiều: mũi tên thẳng đứng trắng
          <path
            d="M50 22 L32 44 L44 44 L44 76 L56 76 L56 44 L68 44 Z"
            fill="#ffffff"
          />
        )}
      </svg>
    );
  }

  // Biển trắng viền đen/vàng (I.401, S.501)
  return (
    <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xs">
      {iconType === "i401" ? (
        // Bắt đầu đường ưu tiên: hình thoi vàng viền trắng viền đen
        <g>
          <polygon
            points="50,12 88,50 50,88 12,50"
            fill="#ffffff"
            stroke="#102a45"
            strokeWidth="2"
          />
          <polygon points="50,22 78,50 50,78 22,50" fill="#eab308" />
        </g>
      ) : (
        // Biển phụ 500m
        <g>
          <rect
            x="10"
            y="24"
            width="80"
            height="52"
            rx="4"
            fill="#ffffff"
            stroke="#102a45"
            strokeWidth="3"
          />
          <text
            x="50"
            y="55"
            textAnchor="middle"
            fill="#102a45"
            fontSize="16"
            fontWeight="bold"
            fontFamily="sans-serif"
          >
            500 m
          </text>
          <line
            x1="16"
            y1="62"
            x2="84"
            y2="62"
            stroke="#102a45"
            strokeWidth="2"
            markerEnd="url(#arrow)"
          />
        </g>
      )}
    </svg>
  );
}

const categories: { key: SignCategory; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "cam", label: "Biển cấm" },
  { key: "nguyhiem", label: "Biển nguy hiểm" },
  { key: "hieulenh", label: "Biển hiệu lệnh" },
  { key: "chidan", label: "Biển chỉ dẫn" },
  { key: "phu", label: "Biển phụ" },
];

export default function SignLibraryPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<SignCategory>("all");
  const [selectedSign, setSelectedSign] = useState<SignItem | null>(null);

  const filteredSigns = useMemo(() => {
    return mockSigns.filter((sign) => {
      if (activeCategory !== "all" && sign.category !== activeCategory) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const query = searchQuery.toLowerCase().trim();
      const searchTarget = (
        sign.code +
        " " +
        sign.name +
        " " +
        sign.shortDesc +
        " " +
        sign.meaning
      ).toLowerCase();
      return searchTarget.includes(query);
    });
  }, [searchQuery, activeCategory]);

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">
            Hệ thống biển báo hiệu đường bộ
          </span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Thư viện biển báo giao thông Việt Nam
            </h1>
            <p className="text-muted text-sm mt-1">
              Quy chuẩn kỹ thuật quốc gia QCVN 41:2019/BGTVT kèm mức phạt theo
              Nghị định 168/2024/NĐ-CP
            </p>
          </div>
          <span className="text-xs px-3 py-1.5 rounded-full bg-selected text-accent-strong self-start font-medium border border-line">
            Chuẩn hóa 5 nhóm biển báo
          </span>
        </div>
      </div>

      {/* Search & Category Filter */}
      <div className="bg-surface rounded-2xl border border-line shadow-xs p-5 mb-8 space-y-4">
        {/* Search Bar */}
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo mã biển (VD: P.102, W.201, R.301) hoặc tên biển báo..."
            className="w-full bg-bg border border-line rounded-xl pl-10 pr-4 py-3 text-sm text-navy placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-muted">
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-navy"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-selected">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted mr-1">
            Phân loại:
          </span>
          {categories.map((cat) => {
            const isActive = activeCategory === cat.key;
            return (
              <button
                key={cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all ${
                  isActive
                    ? "bg-navy text-white shadow-2xs"
                    : "bg-bg text-text-secondary border border-line hover:bg-selected"
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid of Signs */}
      <div className="mb-4 flex items-center justify-between px-1">
        <span className="text-sm font-medium text-navy">
          Hiển thị{" "}
          <span className="font-mono text-accent-strong font-semibold">
            {filteredSigns.length}
          </span>{" "}
          biển báo
        </span>
        <span className="text-xs text-muted">
          Nhấp vào thẻ để xem chi tiết ý nghĩa & lỗi vi phạm
        </span>
      </div>

      {filteredSigns.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-dashed border-line p-12 text-center">
          <p className="font-sans text-lg text-navy">
            Không tìm thấy biển báo nào
          </p>
          <p className="text-sm text-muted mt-1">
            Vui lòng thử tìm kiếm với từ khóa khác.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredSigns.map((sign) => (
            <div
              key={sign.id}
              onClick={() => setSelectedSign(sign)}
              className="bg-surface rounded-2xl border border-line hover:border-accent p-5 cursor-pointer shadow-2xs hover:shadow-md transition-all group flex flex-col justify-between"
            >
              <div>
                {/* Visual Graphic Canvas */}
                <div className="w-24 h-24 mx-auto mb-4 p-2 bg-bg rounded-xl border border-selected flex items-center justify-center group-hover:scale-105 transition-transform">
                  <TrafficSignSvg shape={sign.shape} iconType={sign.iconType} />
                </div>

                {/* Badge & Code */}
                <div className="flex items-center justify-between mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-navy text-white">
                    {sign.code}
                  </span>
                  <span className="text-[11px] font-medium text-muted">
                    {sign.categoryLabel}
                  </span>
                </div>

                {/* Name */}
                <h3 className="font-sans text-[17px] font-semibold text-navy group-hover:text-accent-strong transition-colors leading-snug mb-2">
                  {sign.name}
                </h3>

                {/* Short Desc */}
                <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                  {sign.shortDesc}
                </p>
              </div>

              {/* Action Hint */}
              <div className="mt-4 pt-3 border-t border-selected flex items-center justify-between text-[11px] text-muted">
                <span>
                  {sign.relatedViolations.length} lỗi xử phạt liên quan
                </span>
                <span className="text-accent-strong font-semibold group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-0.5">
                  Xem chi tiết &rarr;
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal / Drawer Chi tiết Biển Báo */}
      {selectedSign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40 backdrop-blur-xs">
          <div className="bg-bg w-full max-w-2xl rounded-2xl border border-line shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-surface">
              <div className="flex items-center gap-3">
                <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-navy text-white">
                  {selectedSign.code}
                </span>
                <div>
                  <h3 className="font-sans text-lg font-semibold text-navy">
                    {selectedSign.name}
                  </h3>
                  <p className="text-[11px] text-muted">
                    {selectedSign.categoryLabel} theo QCVN 41:2019/BGTVT
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedSign(null)}
                className="p-1 rounded-lg text-muted hover:bg-selected hover:text-navy transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 max-h-[75vh] overflow-y-auto space-y-6">
              {/* Graphic + Ý nghĩa */}
              <div className="flex flex-col sm:flex-row gap-5 items-start bg-surface p-4 rounded-xl border border-line">
                <div className="w-28 h-28 shrink-0 mx-auto sm:mx-0 p-3 bg-bg rounded-xl border border-selected flex items-center justify-center">
                  <TrafficSignSvg
                    shape={selectedSign.shape}
                    iconType={selectedSign.iconType}
                  />
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs uppercase tracking-wider font-semibold text-muted">
                    Ý nghĩa biển báo
                  </h4>
                  <p className="text-sm text-navy leading-relaxed">
                    {selectedSign.meaning}
                  </p>
                </div>
              </div>

              {/* Trường hợp áp dụng */}
              <div className="bg-surface p-4 rounded-xl border border-line space-y-1.5">
                <h4 className="text-xs uppercase tracking-wider font-semibold text-muted">
                  Trường hợp áp dụng & Vị trí đặt biển
                </h4>
                <p className="text-xs sm:text-sm text-text-secondary leading-relaxed">
                  {selectedSign.applicableCases}
                </p>
              </div>

              {/* Lỗi vi phạm liên quan & Mức phạt */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs uppercase tracking-wider font-semibold text-navy flex items-center gap-1.5">
                    <svg
                      className="w-4 h-4 text-accent-strong"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    Lỗi vi phạm liên quan & Mức phạt (NĐ 168/2024)
                  </h4>
                  <span className="text-[11px] text-muted">
                    {selectedSign.relatedViolations.length} mức xử lý
                  </span>
                </div>

                {selectedSign.relatedViolations.length === 0 ? (
                  <div className="p-4 bg-surface rounded-xl border border-line text-xs text-muted">
                    Biển này mang tính chất chỉ dẫn hoặc hướng dẫn địa giới,
                    không phát sinh hành vi vi phạm xử phạt trực tiếp trừ khi
                    không chấp hành tín hiệu khác.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {selectedSign.relatedViolations.map((v, idx) => (
                      <div
                        key={idx}
                        className="bg-surface p-4 rounded-xl border border-line space-y-2"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-navy">
                            {v.title}
                          </p>
                          <span className="text-sm font-bold text-accent-strong font-sans shrink-0">
                            {v.fineRange}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-selected text-xs text-muted">
                          {v.demerit && (
                            <span className="px-2 py-0.5 rounded bg-[#fee2e2] text-[#b91c1c] text-[11px] font-medium">
                              {v.demerit}
                            </span>
                          )}
                          <span className="font-mono text-[11px]">
                            {v.clause}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3.5 bg-sidebar border-t border-line">
              <Link
                to="/chat"
                state={{
                  initialQuery: `Giải thích chi tiết quy chuẩn và tình huống thực tế của biển báo ${selectedSign.code} (${selectedSign.name})`,
                }}
                className="text-xs text-navy hover:text-accent-strong font-medium inline-flex items-center gap-1.5"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                Hỏi Chatbot KAG về biển này
              </Link>
              <button
                type="button"
                onClick={() => setSelectedSign(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-text-secondary bg-surface border border-line hover:bg-bg transition-colors"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
