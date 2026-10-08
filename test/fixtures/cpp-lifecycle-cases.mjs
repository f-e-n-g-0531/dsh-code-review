// Synthetic source; verdict expectations stay in tests, never model inputs.
const nl=String.fromCharCode(10);
export const cppLifecycleCases = [
 {id:'thread-exit',old:['RequestStop();','worker.join();','ReleaseState();'].join(nl),defect:['RequestStop();','ReleaseState();','worker.join();'].join(nl),safe:['RequestStop();','worker.join();','ReleaseState();'].join(nl)},
 {id:'debugger-close',old:['worker.join();','debugger->Close();'].join(nl),defect:['debugger->Close();','worker.join();'].join(nl),safe:['RequestStop();','worker.join();','debugger->Close();'].join(nl)},
 {id:'allocator-shutdown',old:['worker.join();','DestroyObjects();','Allocator::Shutdown();'].join(nl),defect:['Allocator::Shutdown();','worker.join();','DestroyObjects();'].join(nl),safe:['RequestStop();','worker.join();','DestroyObjects();','Allocator::Shutdown();'].join(nl)}
];
