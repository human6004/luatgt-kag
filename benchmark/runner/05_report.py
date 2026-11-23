"""Step 5: render one aggregate JSON as a self-contained Markdown report."""
import argparse
from pathlib import Path
from common import BENCH, output_file, read_json


def display(value):
    """Format finite scalar metrics or explicit N/A without inventing a score."""
    return 'N/A' if value is None else f'{value:.4f}'


def table(metrics):
    """Render metric values, denominators and unavailable reasons as Markdown rows."""
    lines = ['| Metric | Giá trị | Mẫu số / số mẫu | N/A và lý do |', '|---|---:|---:|---|']
    for name, m in metrics.items():
        reasons = '; '.join(f'{key}: {value}' for key, value in m.get('na_reasons', {}).items()) or m.get('reason', '')
        lines.append(f'| {name} | {display(m["value"])} | {m.get("denominator", m.get("sample_count", ""))} | {reasons} |')
    return '\n'.join(lines)


def main():
    """Read aggregate metrics and write a new report; no dataset or API mutation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--aggregate', type=Path, required=True)
    parser.add_argument('--output-dir', default=str(BENCH / 'output'))
    args = parser.parse_args()
    data = read_json(args.aggregate)
    lines = ['# Kết quả benchmark chatbot', '', f'- Run: `{data["run_id"]}`',
             f'- Dataset: `{data["dataset_id"]}`', f'- Evaluation: `{data["evaluation_id"]}`',
             f'- Thời điểm tổng hợp: {data["created_at"]}',
             f'- Đã ghi nhận: {data["row_count"]}/{data["planned_row_count"]} câu.',
             f'- Trạng thái: {data["status_counts"]}', '',
             '## Tổng thể', '', table(data['overall']), '',
             'Điểm nội dung cần human review theo rubric trong benchmark/definition.md. '
             'Citation chỉ đo khớp căn cứ gold, không thay thế đánh giá áp dụng luật. '
             'Retriever được đánh giá riêng, không tính trong báo cáo chat. Không có ngưỡng PASS tự đặt. '
             'P50/P95 dùng mọi lượt có latency đo được, gồm cả lỗi và timeout. '
             'Các tỷ lệ nằm trong [0,1]; latency tính bằng ms. '
             'N/A bị loại khỏi mẫu số và phải đọc cùng độ phủ.']
    for group, values in data['groups'].items():
        lines += ['', f'## Theo {group}', '']
        for label, value in values.items():
            lines += [f'### {label} ({value["row_count"]} câu)', '', table(value['metrics']), '']
    path = output_file(args.output_dir, 'report', 'md')
    with path.open('x', encoding='utf-8') as stream:
        stream.write('\n'.join(lines) + '\n')
    print(path)


if __name__ == '__main__':
    main()
