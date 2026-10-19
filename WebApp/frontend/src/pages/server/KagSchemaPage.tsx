import { useState } from "react"

import { Link } from "react-router-dom"

import { Page, Button, Th, Td } from "../../admin/ui"

import { useData, Notice, inputClass } from "./shared"

type Property = {
  logical_name: string
  schema_name: string
  contract_type: string
  required: boolean
  inherited_from?: string
}

export type SchemaResponse = {
  identity: { namespace: string; schema_sha256: string; contract_sha256: string }

  contract: {
    node_types: string[]
    node_properties: Record<string, Property[]>
    relations: Record<string, { from_type: string; to_type: string }>
    unit_type_values: string[]
    runtime_contract: Record<string, unknown>
  }
}

export default function KagSchemaPage() {
  const data = useData<SchemaResponse>("/admin/kag/schema"),
    [type, setType] = useState("LegalDocument")

  const schema = data.value

  function download() {
    if (!schema) return

    const url = URL.createObjectURL(
      new Blob([JSON.stringify(schema.contract, null, 2)], {
        type: "application/json",
      }),
    )

    const link = document.createElement("a")
    link.href = url
    link.download = "schema_contract.json"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Schema & quan hệ"
      subtitle="Cấu trúc LuậtGT đi kèm bộ dữ liệu. Trang chỉ đọc."
      actions={<Button onClick={data.reload}>Cập nhật</Button>}
    >
      <Notice {...data} retry={data.reload} />
      {schema && (
        <>
          <details><summary className="underline cursor-pointer text-sm">Chi tiết kỹ thuật</summary><dl className="grid sm:grid-cols-3 gap-5 py-6 border-b border-line">
            {[
              ["Namespace", schema.identity.namespace],
              ["SHA-256 schema", schema.identity.schema_sha256],
              ["SHA-256 contract", schema.identity.contract_sha256],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="text-sm font-semibold mt-1 break-all">
                  {value}
                </dd>
              </div>
            ))}
          </dl></details>
          <div className="flex flex-wrap gap-4 items-center my-6">
            <Link
              to="/admin/sources"
              className="text-sm underline underline-offset-4"
            >
              Về dữ liệu nguồn
            </Link>
            <Button onClick={download}>Tải contract</Button>
          </div>
          <p className="text-sm">
            Dùng doc_id, unit_id và sign_id nguyên trạng làm ID nguồn. UUID
            trong WebApp chỉ dùng cho quản trị bản ghi. Chat từ dataset đối chiếu
            trích dẫn với bản nguồn của đồ thị đang áp dụng.
          </p>
          <label className="block text-sm mt-6">
            Loại node
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={`${inputClass} mt-2 sm:max-w-sm`}
            >
              {schema.contract.node_types.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Trường nguồn</Th>
                  <Th>Trường graph</Th>
                  <Th>Kiểu dữ liệu</Th>
                  <Th>Contract yêu cầu</Th>
                </tr>
              </thead>
              <tbody>
                {schema.contract.node_properties[type]?.map((p) => (
                  <tr key={p.logical_name}>
                    <Td>{p.logical_name}</Td>
                    <Td>
                      {p.schema_name}
                      {p.inherited_from ? ` (${p.inherited_from})` : ""}
                    </Td>
                    <Td>{p.contract_type}</Td>
                    <Td>{p.required ? "Có" : "Không"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="font-semibold mt-8">Quan hệ graph</h2>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Node nguồn</Th>
                  <Th>Quan hệ</Th>
                  <Th>Node đích</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(schema.contract.relations).map(([name, r]) => (
                  <tr key={name}>
                    <Td>{r.from_type}</Td>
                    <Td>{name}</Td>
                    <Td>{r.to_type}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm mt-6">
            Loại đơn vị pháp lý: {schema.contract.unit_type_values.join(", ")}.
          </p>
          <p className="text-sm mt-3 text-muted">
            Ingestion theo contract runtime: kiểm tra ràng buộc và codec, ghi
            node trước cạnh và gộp provenance trước khi ghi.
          </p>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer">
              Contract runtime cho core KAG
            </summary>
            <pre className="overflow-x-auto mt-3 p-3 bg-sidebar">
              {JSON.stringify(schema.contract.runtime_contract, null, 2)}
            </pre>
          </details>
        </>
      )}
    </Page>
  )
}
