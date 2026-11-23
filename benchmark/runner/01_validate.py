"""Step 1: validate the 13-column dataset and optional CSV/JSON parity."""
import argparse
from common import BENCH, checked_rows, dataset_id


def main():
    """Read dataset paths from CLI; print validation count/hash, with no file writes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', default=str(BENCH / 'data/benchmark.csv'))
    parser.add_argument('--compare', help='Optional equivalent JSON/CSV to compare')
    args = parser.parse_args()
    rows = checked_rows(args.dataset)
    if args.compare and rows != checked_rows(args.compare):
        raise ValueError('CSV and JSON records differ')
    print(f'VALID: {len(rows)} questions; dataset_version/content_id={dataset_id(rows)}')


if __name__ == '__main__':
    main()
