using _3DS.Core.Crypto;
using _3DS.Core.Interfaces;
using _3DS.Core.Models;
using _3DS.Core.Services;
using Common;
using Patch.Core.Services;

internal static class ThreeDs
{
    public static async Task Run(string input, string? patch, string output, string format)
    {
        var keys = new KeyStore();
        await using INcsdSource source = Path.GetExtension(input).ToLowerInvariant() == ".cia"
            ? await new CiaReader(keys).OpenAsync(input)
            : await CciSource.OpenAsync(input, keys);
        if (source.Contents.Count == 0) throw new InvalidDataException("No 3DS partitions");
        if (format is not ("cci" or "cia")) throw new InvalidDataException("Unknown 3DS output format");
        if (patch != null && !Directory.Exists(patch)) throw new InvalidDataException("3DS repacking requires a ZIP/7z/RAR LayeredFS patch");
        var rebuilt = new Dictionary<int, (NcchUnpackResult, byte[], Stream, RomFsUnpackResult?, IRomFsFileSource?)>();
        var streams = new List<Stream>();
        var romfs = new RomFsOverlay(patch == null ? "" : Path.Combine(patch, "romfs"), Path.Combine(output + ".work", "romfs-results"));
        int applied = 0;
        byte[]? exheader0 = null, icon0 = null;
        try
        {
            foreach (var content in source.Contents)
            {
                var (stream, _) = await source.OpenContentDecrypted(content.ContentIndex);
                streams.Add(stream);
                byte[] header = new byte[NcchHeader.Size];
                await stream.ReadExactlyAsync(header);
                var ncch = NcchHeader.Parse(header);
                stream.Position = 0;
                var unpack = await NcchUnpacker.UnpackAsync(stream, ncch);
                if (unpack.ExeFs?.Files.Any(f => !f.HashValid) == true)
                    throw new InvalidDataException("3DS ExeFS checksum mismatch (wrong key or corrupt source)");
                bool main = content.ContentIndex == 0 && patch != null;
                string exheader = patch == null ? "" : Path.Combine(patch, "exheader.bin");
                if (main && File.Exists(exheader))
                {
                    byte[] bytes = await File.ReadAllBytesAsync(exheader);
                    if (bytes.Length != 0x800) throw new InvalidDataException("exheader.bin must be 2048 bytes");
                    unpack = new NcchUnpackResult { Header=unpack.Header, ExHeader=bytes, Logo=unpack.Logo, PlainRegion=unpack.PlainRegion, ExeFs=unpack.ExeFs, RomFs=unpack.RomFs };
                    applied++;
                }
                byte[] exefs = [];
                if (unpack.ExeFs != null)
                {
                    var result = await ExeFsPacker.PackWithPatchAsync(unpack.ExeFs.Files,
                        main ? PatchFileIndex.Build(Path.Combine(patch!,"exefs")) : null,
                        unpack.ExHeader, main ? PatchFileIndex.Build(patch!) : null);
                    exefs = result.Data;
                    applied += result.PatchedCount;
                }
                if (content.ContentIndex == 0)
                {
                    exheader0 = unpack.ExHeader;
                    if (exefs.Length > 0)
                    {
                        var name = System.Text.Encoding.ASCII.GetBytes("icon");
                        for (int i=0; i<8; i++)
                            if (exefs.AsSpan(i*16,4).SequenceEqual(name))
                            {
                                int off = checked((int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(exefs.AsSpan(i*16+8))) + 0x200;
                                int size = checked((int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(exefs.AsSpan(i*16+12)));
                                icon0 = exefs.AsSpan(off,size).ToArray();
                            }
                    }
                }
                rebuilt[content.ContentIndex] = (unpack, exefs, stream, unpack.RomFs, main ? romfs : null);
            }
            await using var repacked = await RepackedNcsdSource.CreateAsync(rebuilt, source.Contents);
            await using var dest = File.Create(output);
            if (format == "cia") await CiaBuilder.BuildAsync(repacked, keys, dest, exheader0, icon0);
            else await NcsdBuilder.BuildAsync(repacked, dest);
            romfs.CheckApplied();
            if (patch != null && applied + romfs.AppliedCount == 0) throw new InvalidDataException("No patch files matched this 3DS ROM");
        }
        finally
        {
            foreach (var stream in streams) await stream.DisposeAsync();
            romfs.Dispose();
        }
    }
}

internal sealed class RomFsOverlay(string root, string scratch) : IRomFsFileSource, IDisposable
{
    readonly Dictionary<string,string> results = new(StringComparer.Ordinal);
    readonly HashSet<string> used = new(StringComparer.Ordinal);
    public int AppliedCount => used.Count;
    public async ValueTask<Stream?> OpenFileAsync(string fullPath, Func<CancellationToken, ValueTask<Stream?>>? getOriginal = null, Action<string, LogLevel>? log = null, CancellationToken ct = default)
    {
        string relative = fullPath.TrimStart('/').Replace('\\','/');
        if (relative.Split('/').Any(p => p is ".." or "." or "") || relative.Contains(':')) throw new InvalidDataException("Unsafe RomFS path");
        string target = Path.Combine(root,relative);
        var candidates = ArchivePatch.PatchExtensions.Select(ext => target+ext).Where(File.Exists).ToList();
        if (File.Exists(target)) candidates.Add(target);
        if (candidates.Count > 1) throw new InvalidDataException("Multiple patches target the same RomFS file");
        if (candidates.Count == 0) return null;
        string selected = candidates[0];
        used.Add(selected);
        if (selected == target) return File.OpenRead(selected);
        if (results.TryGetValue(selected,out var cached)) return File.OpenRead(cached);
        if (getOriginal == null) throw new InvalidDataException("Missing original RomFS data");
        Directory.CreateDirectory(scratch);
        string src=Path.Combine(scratch,Guid.NewGuid().ToString("N")), dest=src+".patched";
        await using (var original = await getOriginal(ct) ?? throw new InvalidDataException("Missing original RomFS file"))
        await using (var file = File.Create(src)) await original.CopyToAsync(file,ct);
        await BinaryPatch.Apply(src,selected,dest);
        File.Delete(src);
        results[selected]=dest;
        return File.OpenRead(dest);
    }
    public void CheckApplied()
    {
        if (Directory.Exists(root) && Directory.EnumerateFiles(root,"*",SearchOption.AllDirectories).Any(f=>!used.Contains(f)))
            throw new InvalidDataException("Some RomFS patch files do not match this ROM");
    }
    public void Dispose() { if(Directory.Exists(scratch)) Directory.Delete(scratch,true); }
}
