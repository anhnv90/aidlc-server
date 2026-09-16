import java.nio.file.{Files, Paths}

@main def exec(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  val content = Seq(
    s"metadata.language=${cpg.metaData.language.l.mkString(",")}",
    s"metadata.overlays=${cpg.metaData.overlays.l.flatten.mkString(",")}",
    s"files=${cpg.file.size}",
    s"typeDecls=${cpg.typeDecl.size}",
    s"methods=${cpg.method.size}",
    s"internalMethods=${cpg.method.isExternal(false).size}",
    s"calls=${cpg.call.size}",
    "sampleMethods=" + cpg.method.isExternal(false).fullName.take(20).l.mkString(" | ")
  ).mkString("\n")
  Files.writeString(Paths.get(outFile), content)
}