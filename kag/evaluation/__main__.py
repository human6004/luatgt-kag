"""Offline CLI only: validate, synthetic/default-nonofficial freeze, explicit import."""
import argparse
from dataclasses import asdict
from pathlib import Path
import sys

from .dataset import canonical_line, dataset_from_records, freeze_dataset, load_dataset, sha256, strict_json
from .legacy import import_legacy
from .generation import generate_questions, validate_generated
from .models import ValidationError, fail
from .report import write_new


def _read(path):
    raw = Path(path).read_bytes()
    try:
        text = raw.decode('utf-8',errors='strict')
        if text.startswith('\ufeff'):
            fail('input','BOM_NOT_ALLOWED')
        return strict_json(text),raw
    except (UnicodeError,ValueError) as exc:
        if isinstance(exc,ValidationError):
            raise
        fail('input','INVALID_JSON')


def positive(value):
    try:
        result = int(value)
        if result <= 0:
            raise ValueError()
        return result
    except ValueError:
        raise argparse.ArgumentTypeError('positive integer required') from None


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    validate=sub.add_parser('validate')
    validate.add_argument('path',type=Path)
    validate.add_argument('--manifest',type=Path)
    freeze=sub.add_parser('freeze')
    freeze.add_argument('path',type=Path)
    freeze.add_argument('--output-root',type=Path,required=True)
    freeze.add_argument('--dataset-version',required=True)
    freeze.add_argument('--review',type=Path)
    generate=sub.add_parser('generate')
    generate.add_argument('--catalog',type=Path,required=True)
    generate.add_argument('--drafts',type=Path,required=True)
    generate.add_argument('--config',type=Path,required=True)
    generate.add_argument('--output-dir',type=Path,required=True)
    generated=sub.add_parser('validate-generated')
    generated.add_argument('path',type=Path)
    generated.add_argument('--catalog',type=Path,required=True)
    generated.add_argument('--generation-manifest',type=Path,required=True)
    legacy=sub.add_parser('import-legacy', help='Convert legacy question/category/answerable/gold_evidence JSON arrays to a provisional dataset',
                         description='Import legacy JSON arrays with explicit citation mapping; Vietnamese cau_hoi JSONL requires manual conversion first.')
    legacy.add_argument('path',type=Path)
    legacy.add_argument('--output-dir',type=Path,required=True)
    legacy.add_argument('--dataset-version',required=True)
    legacy.add_argument('--as-of')
    legacy.add_argument('--mapping',type=Path)
    legacy.add_argument('--catalog',type=Path)
    legacy.add_argument('--limit',type=positive)
    args=parser.parse_args(argv)
    try:
        if args.command == 'validate':
            ds=load_dataset(args.path,args.manifest)
            print(canonical_line({'status':'VALID','dataset_hash':ds.dataset_hash,'record_count':len(ds.records)}).decode(),end='')
        elif args.command == 'validate-generated':
            catalog,raw=_read(args.catalog)
            ds=load_dataset(args.path)
            validate_generated(ds,catalog,_read(args.generation_manifest)[0],source_catalog_sha256=sha256(raw))
            print(canonical_line({'status':'SOURCE_VALIDATED','dataset_hash':ds.dataset_hash,'human_reviewed':False}).decode(),end='')
        elif args.command == 'generate':
            catalog,raw=_read(args.catalog)
            result=generate_questions(catalog,_read(args.drafts)[0],_read(args.config)[0],source_catalog_sha256=sha256(raw))
            args.output_dir.mkdir(parents=True,exist_ok=False)
            write_new(args.output_dir/'generation-manifest.json',canonical_line(result['manifest']))
            if result['records']:
                write_new(args.output_dir/'eval_questions.jsonl',dataset_from_records(result['records']).canonical_bytes)
            print(canonical_line({k:result['manifest'][k] for k in ('requested_count','generated_count','category_counts','deferred','duplicates','review_status')}).decode(),end='')
            return 2 if result['manifest']['deferred'] or not result['records'] else 0
        elif args.command == 'freeze':
            review=_read(args.review)[0] if args.review else None
            path=freeze_dataset(args.path,args.output_root,args.dataset_version,review_receipt=review)
            print(canonical_line({'manifest_path':str(path),'official_benchmark':False}).decode(),end='')
        else:
            payload,raw=_read(args.path)
            if type(payload) is not list:
                fail('payload','LEGACY_LIST_REQUIRED')
            if args.limit:
                payload=payload[:args.limit]
            mapping=_read(args.mapping)[0] if args.mapping else None
            catalog=_read(args.catalog)[0] if args.catalog else None
            result=import_legacy(payload,dataset_version=args.dataset_version,as_of=args.as_of,mapping=mapping,current_catalog=catalog)
            result['provenance']['source_sha256']=sha256(raw)
            result['provenance']['source_record_count']=len(_read(args.path)[0])
            output=args.output_dir
            output.mkdir(parents=True,exist_ok=False)
            write_new(output/'import_report.json',canonical_line(result))
            text='DATASET_STATUS=PROVISIONAL\nOFFICIAL_BENCHMARK=NO\nPAPER_ELIGIBLE=NO\n\n'+str(result['counts'])+'\n'
            write_new(output/'import_report.md',text.encode('utf-8'))
            if result['converted']:
                write_new(output/'eval_questions.jsonl',dataset_from_records(result['converted']).canonical_bytes)
            print(canonical_line(result['counts']).decode(),end='')
            return 2 if result['rejected'] or result['needs_manual_mapping'] else 0
        return 0
    except ValidationError as exc:
        print(canonical_line({'status':'INVALID','issues':[asdict(i) for i in exc.issues]}).decode(),end='')
        return 2
    except OSError as exc:
        print(canonical_line({'status':'ERROR','code':'IO_ERROR','type':type(exc).__name__}).decode(),end='')
        return 1


if __name__ == '__main__':
    sys.exit(main())
