import { useEffect, useState } from "react"

import { api, media } from "../../api"

import { Button } from "../../admin/ui"

export function useData<T>(path: string) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setValue(undefined)
    api<T>(path, { signal: controller.signal })
      .then((v) => {
        if (!controller.signal.aborted) setValue(v)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [path, version])

  return { value, error, loading, reload: () => setVersion((v) => v + 1) }
}

export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  async function run(task: () => Promise<void>) {
    setBusy(true)
    setError("")
    try {
      await task()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, clearError: () => setError("") }
}

export function Notice({
  error,
  loading,
  empty = false,
  retry,
}: {
  error?: string
  loading?: boolean
  empty?: boolean
  retry?: () => void
}) {
  return (
    <>
      {loading && (
        <p role="status" className="py-4 text-muted">
          Đang tải dữ liệu…
        </p>
      )}
      {error && (
        <div role="alert" className="py-4 text-red-700">
          {error}
          {retry && (
            <Button className="ml-3" onClick={retry}>
              Thử lại
            </Button>
          )}
        </div>
      )}
      {empty && !loading && !error && (
        <p className="py-8 text-muted">Chưa có dữ liệu.</p>
      )}
    </>
  )
}

export function Asset({
  id,
  alt,
  path,
  className = "max-h-96 max-w-full object-contain my-4",
}: {
  id: string
  alt: string
  path?: string
  className?: string
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true,
      u = ""
    setUrl("")
    setError("")
    media(id, path)
      .then((v) => {
        u = v
        if (active) setUrl(v)
        else URL.revokeObjectURL(v)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [id, path])
  return (
    <>
      {url && (
        <img
          src={url}
          alt={alt}
          className={className}
        />
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </>
  )
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function download(id: string) {
  const url = await media(id)
  const a = document.createElement("a")
  a.href = url
  a.download = `nguon-${id}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
